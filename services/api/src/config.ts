/** 环境配置（所有配置集中在入口读取，便于测试注入） */
import { resolve } from "node:path";

/**
 * Phase 0 轻量 bootstrap 凭据：单账号。
 * - 生产：配置 CAM_BOOTSTRAP_PASSWORD（明文）或 CAM_BOOTSTRAP_PASSWORD_HASH（scrypt，`salt$hashHex`）。
 * - 未配置时仅开发态默认（demo@ai-cam.local / demo），启动日志会警告。
 * orgId 与 role 一律服务端解算，不接受客户端传入。
 */
export interface BootstrapAuthConfig {
  email: string;
  orgId: string;
  /** 服务端固定角色（对应 @ai-cam/security 的 Role，大写） */
  role: string;
  /** 明文密码（未配置哈希时使用） */
  password?: string;
  /** scrypt 哈希形式：salt$hashHex */
  passwordHash?: { salt: string; hashHex: string };
  /** 是否走了开发态默认值（用于启动日志警告） */
  usingDefaults: boolean;
}

/** P0-04：R2 / S3 兼容对象存储配置（STORAGE_DRIVER=r2 时必填核心字段） */
export interface R2StorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  /** 自定义 S3 端点（如本地 MinIO）；缺省走 R2 官方域名 */
  endpoint?: string;
}

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  nodeEnv: string;
  jwt: { secret: string; issuer: string; expiresIn: string; usingDefault: boolean };
  /** P2-40：CORS 白名单 Origin（逗号分隔的 CORS_ORIGINS；非白名单 Origin 不回 ACAO） */
  corsOrigins: string[];
  /** P2-42：Fastify bodyLimit 上限（默认 64MB，BODY_LIMIT_BYTES 可覆盖） */
  bodyLimitBytes: number;
  storage: { driver: "local" | "r2"; dataDir: string; r2?: R2StorageConfig };
  /** P0-01：PostgreSQL 连接串；缺省时降级为内存 store（仅开发/测试，启动打 WARN） */
  databaseUrl?: string;
  /** P0-03：bootstrap 管理员（首启播种 users/memberships；PG 模式使用） */
  admin: { email: string; password: string; orgId: string };
  /** 零件解析器：fixture（Golden 夹具，默认）| worker（OCCT 本地二进制） */
  partsAnalyzer: { mode: "fixture" | "worker"; fixturesDir: string; binaryPath?: string };
  /** Phase 0 bootstrap 登录凭据（单账号；仅在无 DATABASE_URL 的内存降级路径使用） */
  auth: { bootstrap: BootstrapAuthConfig };
  /** AI 规划：是否配置了真实 LLM 凭据（未配置则全程 MockProvider） */
  ai: { llmLive: boolean };
  /** P1-08：审计持久化落点 memory|file|pg（默认 memory 保测试；生产建议 pg） */
  auditSink: "memory" | "file" | "pg";
  otlpEndpoint?: string;
}

/** 解析 CAM_BOOTSTRAP_PASSWORD_HASH（格式 `salt$hashHex`），非法格式返回 undefined */
function parsePasswordHash(raw: string | undefined): { salt: string; hashHex: string } | undefined {
  if (!raw) return undefined;
  const idx = raw.indexOf("$");
  if (idx <= 0 || idx === raw.length - 1) return undefined;
  const salt = raw.slice(0, idx);
  const hashHex = raw.slice(idx + 1).trim();
  if (!/^[0-9a-fA-F]+$/.test(hashHex)) return undefined;
  return { salt, hashHex };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const driver = (env.STORAGE_DRIVER ?? "local") as AppConfig["storage"]["driver"];
  if (driver !== "local" && driver !== "r2") {
    throw new Error(`Unknown STORAGE_DRIVER: ${driver}`);
  }
  const partsMode = (env.PARTS_ANALYZER ?? "fixture") as AppConfig["partsAnalyzer"]["mode"];
  if (partsMode !== "fixture" && partsMode !== "worker") {
    throw new Error(`Unknown PARTS_ANALYZER: ${partsMode}`);
  }

  // ---- P2-40 CORS 白名单（逗号分隔；仅白名单 Origin 回 ACCESS-CONTROL-ALLOW-ORIGIN）----
  const corsOrigins = (env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // ---- P2-42 bodyLimit 上限（默认 64MB）----
  const bodyLimitBytesRaw = Number(env.BODY_LIMIT_BYTES ?? 64 * 1024 * 1024);
  const bodyLimitBytes = Number.isFinite(bodyLimitBytesRaw) && bodyLimitBytesRaw > 0 ? Math.floor(bodyLimitBytesRaw) : 64 * 1024 * 1024;

  // ---- P2-43 JWT secret：生产必须显式配置，开发保留默认值 ----
  const jwtSecret = env.JWT_SECRET;
  const jwtUsingDefault = !jwtSecret;
  if (env.NODE_ENV === "production" && !jwtSecret) {
    throw new Error("JWT_SECRET must be set when NODE_ENV=production. Refusing to start with a default dev secret.");
  }

  // ---- P0-01：PostgreSQL 连接串（缺省 undefined → app 降级内存 store 并打 WARN）----
  const databaseUrl = env.DATABASE_URL || undefined;

  // ---- P0-03：bootstrap 管理员（PG 模式首启播种 users/memberships）----
  const adminEmail = (env.ADMIN_EMAIL ?? "admin@ai-cam.local").trim().toLowerCase();
  const adminPassword = env.ADMIN_PASSWORD ?? "changeme-admin";
  const adminOrgId = env.ADMIN_ORG ?? "org_admin";

  // ---- P0-04：R2 / S3 兼容对象存储（driver=r2 时必填核心字段，缺参即拒绝启动）----
  let r2: R2StorageConfig | undefined;
  if (driver === "r2") {
    const accountId = env.R2_ACCOUNT_ID ?? "";
    const accessKeyId = env.R2_ACCESS_KEY_ID ?? "";
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? "";
    const bucket = env.R2_BUCKET ?? "";
    for (const [name, val] of [
      ["R2_ACCOUNT_ID", accountId],
      ["R2_ACCESS_KEY_ID", accessKeyId],
      ["R2_SECRET_ACCESS_KEY", secretAccessKey],
      ["R2_BUCKET", bucket],
    ] as const) {
      if (!val) throw new Error(`STORAGE_DRIVER=r2 requires ${name} to be set.`);
    }
    r2 = {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket,
      publicUrl: env.R2_PUBLIC_URL ?? "",
      endpoint: env.R2_ENDPOINT?.trim() || undefined,
    };
  }

  // ---- Phase 0 bootstrap 凭据（服务端解算 org_id/role；仅内存降级路径使用）----
  const email = env.CAM_BOOTSTRAP_EMAIL ?? "demo@ai-cam.local";
  const orgId = env.CAM_BOOTSTRAP_ORG ?? "org_demo";
  const passwordHash = parsePasswordHash(env.CAM_BOOTSTRAP_PASSWORD_HASH);
  const hasExplicitCred = Boolean(env.CAM_BOOTSTRAP_PASSWORD) || Boolean(passwordHash);
  // 未配置任何凭据时走开发态默认密码 demo；usingDefaults 供启动日志告警
  const password = hasExplicitCred ? env.CAM_BOOTSTRAP_PASSWORD : "demo";

  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    nodeEnv: env.NODE_ENV ?? "development",
    corsOrigins,
    bodyLimitBytes,
    jwt: {
      secret: jwtSecret ?? "dev-secret-change-me",
      issuer: env.JWT_ISSUER ?? "ai-cam-api",
      expiresIn: env.JWT_EXPIRES_IN ?? "24h",
      usingDefault: jwtUsingDefault,
    },
    storage: {
      driver,
      // P0-02：优先 STORAGE_DATA_DIR（与 .env.example 对齐）；DATA_DIR 为旧变量保留兼容
      dataDir: env.STORAGE_DATA_DIR ?? env.DATA_DIR ?? "./data",
      r2,
    },
    databaseUrl,
    admin: { email: adminEmail, password: adminPassword, orgId: adminOrgId },
    partsAnalyzer: {
      mode: partsMode,
      fixturesDir: env.FIXTURES_DIR ?? resolve(process.cwd(), "../../tests/golden/parts"),
      binaryPath: env.GEOMETRY_WORKER_BIN,
    },
    auth: {
      bootstrap: {
        email: email.trim().toLowerCase(),
        orgId,
        // 服务端固定角色：Phase 0 单账号默认工程师；角色经 RBAC 矩阵校验
        role: "ENGINEER",
        password,
        passwordHash,
        usingDefaults: !hasExplicitCred,
      },
    },
    otlpEndpoint: env.OTLP_ENDPOINT,
    // P1-17：任一真实 LLM 厂商 key 存在即视为 live；否则全程 MockProvider
    ai: {
      llmLive: Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.DEEPSEEK_API_KEY || env.LLM_API_KEY),
    },
    // ---- P1-08：审计 sink 落点（默认 memory 保测试；生产建议 pg）----
    auditSink: (env.AUDIT_SINK as "memory" | "file" | "pg" | undefined) ?? "memory",
  };
}
