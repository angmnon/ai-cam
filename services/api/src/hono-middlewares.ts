/**
 * Hono 中间件与工具（替代 Fastify 的 plugins/*）。
 * 业务层（stores / auth-backend / llm / security / event-schema）零改复用。
 *
 * 覆盖：
 *  - MetricsRegistry（与 Fastify 版完全一致，/metrics 文本 exposition 不变）
 *  - request-context（requestId + W3C traceparent 透传）
 *  - auth（JWT 双通道 Bearer + HttpOnly cookie）
 *  - authorize（RBAC 中间件工厂）
 *  - metrics（HTTP 埋点 + /metrics 路由）
 *  - security-headers（CORS 白名单 + CSP）
 *  - error（onError 映射 ApiError / 422 / 500）
 */
import { Context, Next, MiddlewareHandler } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import {
  ROLES,
  type Action,
  type Role,
  type AuditSink,
  assertCan,
  AccessDeniedError,
  recordAudit,
} from "@ai-cam/security";
import type { AppEnv, AuthUser, AuthModule } from "./hono-env.js";

/* ------------------------------------------------------------------ *
 * 指标注册表（与 Fastify plugins/metrics.ts 行为对齐）
 * ------------------------------------------------------------------ */
const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
type LabelBag = Record<string, string>;

function labelKey(labels: LabelBag): string {
  return Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",");
}
function renderLabels(labels: LabelBag): string {
  const inner = Object.keys(labels).sort().map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(",");
  return `{${inner}}`;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, { name: string; labels: LabelBag; value: number }>();
  private readonly jobCounters = new Map<string, number>();
  private readonly histograms = new Map<string, { method: string; route: string; counts: number[]; sum: number; count: number }>();

  incCounter(name: string, labels: LabelBag): void {
    const key = `${name}|${labelKey(labels)}`;
    const row = this.counters.get(key);
    if (row) row.value += 1;
    else this.counters.set(key, { name, labels, value: 1 });
  }
  observeDuration(method: string, route: string, ms: number): void {
    const key = `${method}|${route}`;
    let h = this.histograms.get(key);
    if (!h) {
      h = { method, route, counts: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(key, h);
    }
    for (let i = 0; i < BUCKETS.length; i++) if (ms <= BUCKETS[i]) h.counts[i] += 1;
    h.sum += ms;
    h.count += 1;
  }
  recordJob(status: string): void {
    this.jobCounters.set(status, (this.jobCounters.get(status) ?? 0) + 1);
  }
  render(): string {
    const lines: string[] = [];
    lines.push("# HELP http_requests_total Total HTTP requests.", "# TYPE http_requests_total counter");
    for (const c of this.counters.values()) if (c.name === "http_requests_total") lines.push(`http_requests_total${renderLabels(c.labels)} ${c.value}`);
    lines.push("# HELP http_errors_total Total HTTP responses with status >= 500.", "# TYPE http_errors_total counter");
    for (const c of this.counters.values()) if (c.name === "http_errors_total") lines.push(`http_errors_total${renderLabels(c.labels)} ${c.value}`);
    lines.push("# HELP http_request_duration_ms HTTP request latency in milliseconds.", "# TYPE http_request_duration_ms histogram");
    for (const h of this.histograms.values()) {
      const base = { method: h.method, route: h.route };
      let cum = 0;
      for (let i = 0; i < BUCKETS.length; i++) {
        cum += h.counts[i];
        lines.push(`http_request_duration_ms_bucket${renderLabels({ ...base, le: String(BUCKETS[i]) })} ${cum}`);
      }
      lines.push(`http_request_duration_ms_bucket${renderLabels({ ...base, le: "+Inf" })} ${h.count}`);
      lines.push(`http_request_duration_ms_sum${renderLabels(base)} ${h.sum.toFixed(3)}`);
      lines.push(`http_request_duration_ms_count${renderLabels(base)} ${h.count}`);
    }
    lines.push("# HELP jobs_completed_total Total background CAM jobs completed by terminal status.", "# TYPE jobs_completed_total counter");
    for (const [status, value] of this.jobCounters) lines.push(`jobs_completed_total${renderLabels({ status })} ${value}`);
    return lines.join("\n") + "\n";
  }
}

/* ------------------------------------------------------------------ *
 * JWT 模块（Hono 版，与 Fastify plugins/auth.ts 行为对齐）
 * ------------------------------------------------------------------ */
export function createAuth(opts: { secret: string; issuer: string; expiresIn: string }): AuthModule {
  const secretKey = new TextEncoder().encode(opts.secret);
  return {
    async signToken(user: AuthUser) {
      return new SignJWT({ org_id: user.org_id, roles: user.roles })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.sub)
        .setIssuer(opts.issuer)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn)
        .sign(secretKey);
    },
    async verifyToken(token: string) {
      const { payload } = await jwtVerify(token, secretKey, { issuer: opts.issuer });
      const orgId = typeof payload.org_id === "string" ? payload.org_id : "";
      const roles = Array.isArray(payload.roles) ? (payload.roles as string[]).map(String) : [];
      return { sub: payload.sub ?? "", org_id: orgId, roles };
    },
  };
}

export const SESSION_COOKIE_NAME = "aicam_session";
const SESSION_MAX_AGE_SEC = 86400;

export function buildSessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function buildClearCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function readSessionCookie(raw: string | undefined): string | null {
  if (!raw) return null;
  for (const seg of raw.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const name = seg.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      const val = seg.slice(eq + 1).trim();
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 公开路径白名单（auth 中间件放行）
 * ------------------------------------------------------------------ */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/health",
  "/metrics",
  "/docs",
  "/api/v1/auth/login",
  "/api/v1/auth/logout",
  "/api/v1/auth/forgot-password",
  "/api/v1/auth/reset-password",
]);
function isPublic(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  // /docs/* 与 swagger 静态资源
  if (path.startsWith("/docs")) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * request-context：requestId + W3C traceparent 透传
 * ------------------------------------------------------------------ */
function parseIncomingTraceId(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.trim().split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (!/^[0-9a-fA-F]{2}$/.test(version)) return null;
  if (!/^[0-9a-fA-F]{32}$/.test(traceId) || traceId === "0".repeat(32)) return null;
  if (!/^[0-9a-fA-F]{16}$/.test(parentId) || parentId === "0".repeat(16)) return null;
  if (!/^[0-9a-fA-F]{2}$/.test(flags)) return null;
  return traceId.toLowerCase();
}

export function requestContextMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = typeof incoming === "string" && incoming.length > 0 ? incoming : `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const traceId =
      parseIncomingTraceId(c.req.header("traceparent")) ?? crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    c.set("requestId", requestId);
    c.set("traceId", traceId);
    await next();
    c.header("x-request-id", requestId);
    c.header("traceparent", `00-${traceId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`);
  };
}

/* ------------------------------------------------------------------ *
 * auth：JWT 双通道校验，设置 c.user
 * ------------------------------------------------------------------ */
export function authMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    if (isPublic(c.req.path)) {
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    let token: string | null = null;
    if (header.startsWith("Bearer ")) token = header.slice(7);
    else token = readSessionCookie(c.req.header("cookie") ?? "");
    if (!token) {
      throw new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "Missing bearer token or session cookie.", stage: "auth" });
    }
    try {
      const user = await c.get("auth").verifyToken(token);
      c.set("user", user);
    } catch {
      throw new ApiError({ code: ErrorCodes.AUTH_TOKEN_EXPIRED, message: "Invalid or expired token.", stage: "auth" });
    }
    await next();
  };
}

/* ------------------------------------------------------------------ *
 * authorize：RBAC 中间件工厂（依赖 auth 中间件已设置 user）
 * ------------------------------------------------------------------ */
export function authorizeFactory(auditSink: AuditSink): (action: Action) => MiddlewareHandler<AppEnv> {
  return (action: Action) => {
    return async (c: Context<AppEnv>, next: Next) => {
      const user = c.get("user");
      if (!user) {
        throw new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "No authenticated user.", stage: "rbac" });
      }
      const rawRole = (user.roles[0] ?? "").toUpperCase();
      if (!(ROLES as readonly string[]).includes(rawRole)) {
        await recordAudit(auditSink, { actor: user.sub, role: rawRole || "UNKNOWN", action, resource: c.req.path, detail: "未知角色" }, "DENIED");
        throw new ApiError({ code: ErrorCodes.AUTH_FORBIDDEN, message: `角色 ${rawRole || "匿名"} 无 ${action} 权限`, stage: "rbac" });
      }
      const role = rawRole as Role;
      try {
        assertCan(role, action);
      } catch (e) {
        if (e instanceof AccessDeniedError) {
          await recordAudit(auditSink, { actor: user.sub, role, action, resource: c.req.path, detail: e.message }, "DENIED");
          throw new ApiError({ code: ErrorCodes.AUTH_FORBIDDEN, message: e.message, stage: "rbac" });
        }
        throw e;
      }
      await recordAudit(auditSink, { actor: user.sub, role, action, resource: c.req.path }, "ALLOWED");
      await next();
    };
  };
}

/* ------------------------------------------------------------------ *
 * metrics：HTTP 埋点（onRequest 记 start，onResponse 记计数/直方图）
 * ------------------------------------------------------------------ */
export function metricsMiddleware(registry: MetricsRegistry): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    const start = performance.now();
    await next();
    const route = c.req.routePath || "unhandled";
    const method = c.req.method;
    const status = String(c.res.status);
    registry.incCounter("http_requests_total", { method, route, status });
    if (c.res.status >= 500) registry.incCounter("http_errors_total", { method, route, status });
    registry.observeDuration(method, route, performance.now() - start);
  };
}

/** /metrics 端点处理器（METRICS_TOKEN 鉴权在路由内） */
export function metricsHandler(registry: MetricsRegistry, token?: string) {
  return async (c: Context<AppEnv>) => {
    if (token) {
      const header = c.req.header("authorization") ?? "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
      const queryToken = (c.req.query("token") as string | undefined) ?? "";
      if (bearer !== token && queryToken !== token) {
        throw new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "Unauthorized metrics scrape.", stage: "metrics" });
      }
    } else {
      console.warn("METRICS_TOKEN 未配置：/metrics 端点当前公开可访问（生产必须配置）。");
    }
    c.header("content-type", "text/plain; version=0; charset=utf-8");
    return c.body(registry.render());
  };
}

/* ------------------------------------------------------------------ *
 * security-headers：CSP（helmet 其余安全头在 worker 层由 platform 提供）
 * ------------------------------------------------------------------ */
const CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self' http://localhost:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:";

export function cspMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    await next();
    c.res.headers.set("content-security-policy", CSP);
  };
}

/* ------------------------------------------------------------------ *
 * error：onError 统一映射
 * ------------------------------------------------------------------ */
const CSP_ERR = CSP;
export function errorHandler(err: unknown, c: Context<AppEnv>) {
  if (err instanceof ApiError) {
    return c.json(err.toResponse(c.get("requestId")), err.status as any, { "content-security-policy": CSP_ERR });
  }
  console.error({ err }, "unhandled error");
  const wrapped = new ApiError({
    code: ErrorCodes.SYSTEM_INTERNAL,
    message: "Internal server error.",
    stage: "api",
    retryable: true,
  });
  return c.json(wrapped.toResponse(c.get("requestId")), 500, { "content-security-policy": CSP_ERR });
}
