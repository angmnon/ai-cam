/**
 * Auth：演示登录（JWT，HS256）+ 受保护路由校验。
 * Phase 0 为骨架：生产环境换 OIDC / 企业 SSO，并接入 Cloudflare Access（架构 §36）。
 *
 * P2-02：凭据双通道 ——
 *   1) Authorization: Bearer <jwt>（服务端 inject/单测/脚本仍走此通道）
 *   2) HttpOnly Cookie aicam_session=<jwt>（浏览器通道；XSS 读不到 token 明文）
 * 两者任一通过即放行；优先 Bearer，缺失时回落到 cookie。
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { fpRoot } from "./fp.js";

/** P2-02：HttpOnly 会话 cookie 名（与前端 apps/web 约定一致；JS 不可读） */
export const SESSION_COOKIE_NAME = "aicam_session";

export interface AuthUser {
  sub: string;
  org_id: string;
  roles: string[];
}

export interface AuthOptions {
  secret: string;
  issuer: string;
  expiresIn: string;
}

declare module "fastify" {
  interface FastifyInstance {
    auth: {
      signToken(user: AuthUser): Promise<string>;
      verifyToken(token: string): Promise<AuthUser>;
    };
  }
}

export function authPlugin(opts: AuthOptions): FastifyPluginAsync {
  const secretKey = new TextEncoder().encode(opts.secret);

  const auth: FastifyInstance["auth"] = {
    async signToken(user) {
      return new SignJWT({ org_id: user.org_id, roles: user.roles })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.sub)
        .setIssuer(opts.issuer)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn)
        .sign(secretKey);
    },
    async verifyToken(token) {
      const { payload } = await jwtVerify(token, secretKey, { issuer: opts.issuer });
      const orgId = typeof payload.org_id === "string" ? payload.org_id : "";
      const roles = Array.isArray(payload.roles) ? (payload.roles as string[]).map(String) : [];
      return { sub: payload.sub ?? "", org_id: orgId, roles };
    },
  };

  /** 从 Cookie 请求头解析 aicam_session 值（零依赖手写解析，避免引入 @fastify/cookie）。 */
  function readSessionCookie(req: { headers: { cookie?: string } }): string | null {
    const raw = req.headers.cookie;
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

  const plugin: FastifyPluginAsync = async (app) => {
    app.decorate("auth", auth);
    app.addHook("onRequest", async (request, _reply) => {
      // 公开路径
      if (request.routeOptions.url === "/health" || request.routeOptions.url === "/docs" || request.routeOptions.url?.startsWith("/docs/")) {
        return;
      }
      if (request.routeOptions.url === "/api/v1/auth/login") {
        return;
      }
      // P2-02：logout 不需要凭据（清 cookie 本身就是幂等操作；未登录也 204）
      if (request.routeOptions.url === "/api/v1/auth/logout") {
        return;
      }
      // P2-06：密码自助端点无需 JWT（token 自身即凭据）
      if (request.routeOptions.url === "/api/v1/auth/forgot-password" || request.routeOptions.url === "/api/v1/auth/reset-password") {
        return;
      }
      // P2-01：Prometheus 抓取端点（由路由内自行用 METRICS_TOKEN 校验）
      if (request.routeOptions.url === "/metrics") {
        return;
      }
      const header = request.headers.authorization;
      let token: string | null = null;
      if (header && header.startsWith("Bearer ")) {
        token = header.slice(7);
      } else {
        // P2-02：无 Bearer 时回落到 HttpOnly cookie
        token = readSessionCookie(request);
      }
      if (!token) {
        throw new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "Missing bearer token or session cookie.", stage: "auth" });
      }
      try {
        const user = await auth.verifyToken(token);
        request.user = user;
      } catch {
        throw new ApiError({ code: ErrorCodes.AUTH_TOKEN_EXPIRED, message: "Invalid or expired token.", stage: "auth" });
      }
    });
  };
  return fpRoot(plugin);
}
