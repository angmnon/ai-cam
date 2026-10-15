/**
 * Hono 应用环境类型（Bindings + Variables）。
 *
 * 为避免依赖 @cloudflare/workers-types（保持本地 tsc 可编译），workerd 的
 * KV/R2/Hyperdrive/Queues/DO 绑定在此以宽松类型承载，需要时在使用处显式 cast。
 */
import type { StorageAdapter } from "./storage/storage.js";
import type { EventBus } from "./bus/event-bus.js";
import type { JobStore } from "./jobs/job-store.js";
import type { PartStore } from "./parts/part-store.js";
import type { CamStore } from "./cam/cam-store.js";
import type { JobRunStore } from "./cam/job-run-store.js";
import type { ReleaseStore } from "./cam/release-store.js";
import type { AiPlanStore } from "./cam/ai-plan-store.js";
import type { PartAnalyzer } from "./parts/analyzer.js";
import type { AuthBackend } from "./auth/backends.js";
import type { ModelGateway } from "@ai-cam/model-gateway";
import type { AuditSink } from "@ai-cam/security";
import type { LoginService } from "./auth/login-service.js";
import type { AppConfig } from "./config.js";
import type { MetricsRegistry } from "./hono-middlewares.js";
import type { Action } from "@ai-cam/security";
import type { MiddlewareHandler } from "hono";

export interface AuthUser {
  sub: string;
  org_id: string;
  roles: string[];
}

/** workerd 执行上下文（最小可用子集，避免引入 workers-types） */
export interface CfExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: Record<string, unknown>;
}

/** worker env：vars/secrets + 各类绑定 */
export interface Bindings {
  AI_CAM_KV?: unknown;
  AI_CAM_FILES?: unknown;
  AI_CAM_DB?: { connectionString: string };
  AI_CAM_JOBS?: unknown;
  AI_CAM_EVENTS?: unknown;
  /** vars / secrets 也挂在 env 上，loadConfig 读取 */
  [key: string]: unknown;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user?: AuthUser;
    requestId: string;
    traceId: string;
    /** 以下为 DI 注入的业务服务（每个请求由根中间件统一 set） */
    config: AppConfig;
    storage: StorageAdapter;
    bus: EventBus;
    jobs: JobStore;
    parts: PartStore;
    partsAnalyzer: PartAnalyzer;
    cams: CamStore;
    jobRuns: JobRunStore;
    releases: ReleaseStore;
    aiPlans: AiPlanStore;
    authBackend: AuthBackend;
    aiLlm: boolean;
    llmGateway: ModelGateway;
    auditSink: AuditSink;
    loginService: LoginService;
    metrics: MetricsRegistry;
    bootstrap: AppConfig["auth"]["bootstrap"];
    /** RBAC 授权中间件工厂（闭包持有 auditSink） */
    authorize: (action: Action) => MiddlewareHandler<AppEnv>;
    /** JWT 模块：签发（登录路由）+ 校验（auth 中间件） */
    auth: AuthModule;
  };
};

/** JWT 签发/校验模块 */
export interface AuthModule {
  signToken(user: AuthUser): Promise<string>;
  verifyToken(token: string): Promise<AuthUser>;
}
