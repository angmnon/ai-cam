/**
 * Hono 版 App 工厂（替代 Fastify app.ts）。
 * 业务层（stores / auth-backend / llm / security / event-schema / db）零改复用；
 * 仅替换 HTTP 层为 Hono。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { Bindings, AppEnv } from "./hono-env.js";
import { InMemoryEventBus, type EventBus } from "./bus/event-bus.js";
import { createJobStore, type JobStore } from "./jobs/job-store.js";
import { createPartStore, type PartStore } from "./parts/part-store.js";
import { createCamStore, type CamStore } from "./cam/cam-store.js";
import { createJobRunStore, type JobRunStore } from "./cam/job-run-store.js";
import { createReleaseStore, type ReleaseStore } from "./cam/release-store.js";
import { createAiPlanStore } from "./cam/ai-plan-store.js";
import { createFixtureAnalyzer, createWorkerAnalyzer, type PartAnalyzer } from "./parts/analyzer.js";
import { R2Adapter } from "./storage/r2-adapter.js";
import { LocalDiskAdapter } from "./storage/local-adapter.js";
import type { StorageAdapter } from "./storage/storage.js";
import type { AuthBackend } from "./auth/backends.js";
import { BootstrapAuthBackend, PgAuthBackend } from "./auth/backends.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { seedBootstrapAdmin } from "./db/bootstrap.js";
import { createPgPartStore } from "./db/pg/pg-part-store.js";
import { createPgJobStore } from "./db/pg/pg-job-store.js";
import { createPgCamStore } from "./db/pg/pg-cam-store.js";
import { createPgJobRunStore } from "./db/pg/pg-job-run-store.js";
import { createPgReleaseStore } from "./db/pg/pg-release-store.js";
import { PgAuditSink } from "./db/pg/pg-audit-sink.js";
import { MemoryAuditSink, FileAuditSink, type AuditSink } from "@ai-cam/security";
import { LoginService } from "./auth/login-service.js";
import { buildLlmGateway } from "./llm/build-gateway.js";
import {
  MetricsRegistry,
  createAuth,
  requestContextMiddleware,
  authMiddleware,
  authorizeFactory,
  metricsMiddleware,
  metricsHandler,
  cspMiddleware,
  errorHandler,
} from "./hono-middlewares.js";
import { registerRoutes } from "./hono-routes.js";

export interface AppDeps {
  config?: AppConfig;
  env?: Bindings;
  storage?: StorageAdapter;
  bus?: EventBus;
  jobs?: JobStore;
  parts?: PartStore;
  partsAnalyzer?: PartAnalyzer;
  cams?: CamStore;
  jobRuns?: JobRunStore;
  releases?: ReleaseStore;
}

export async function buildApp(deps: AppDeps = {}): Promise<Hono<AppEnv>> {
  const config = deps.config ?? (await import("./config.js")).loadConfig();
  const app = new Hono<AppEnv>();

  // ---- 依赖装配（与 Fastify app.ts 同源逻辑）----
  const bus = deps.bus ?? new InMemoryEventBus();
  const storage =
    deps.storage ??
    (config.storage.driver === "r2" && config.storage.r2
      ? new R2Adapter(config.storage.r2)
      : new LocalDiskAdapter(config.storage.dataDir));

  const injected = Boolean(deps.parts ?? deps.jobs ?? deps.cams ?? deps.jobRuns ?? deps.releases);
  let pgPool: import("pg").Pool | undefined;
  let jobs: JobStore = deps.jobs ?? createJobStore(bus);
  let parts: PartStore = deps.parts ?? createPartStore();
  let cams: CamStore = deps.cams ?? createCamStore();
  let jobRuns: JobRunStore = deps.jobRuns ?? createJobRunStore();
  let releases: ReleaseStore = deps.releases ?? createReleaseStore();
  let authBackend: AuthBackend;

  if (!injected && config.databaseUrl) {
    console.info("DATABASE_URL 已配置，使用 PostgreSQL 持久层。");
    pgPool = createPool(config.databaseUrl);
    try {
      await runMigrations(pgPool, { logger: { info: (m: string) => console.info(m), warn: (m: string) => console.warn(m) } });
      await seedBootstrapAdmin(pgPool, config);
      console.info("数据库迁移与 bootstrap 管理员播种完成。");
    } catch (err) {
      await pgPool.end().catch(() => undefined);
      throw err;
    }
    jobs = createPgJobStore(pgPool, bus);
    parts = createPgPartStore(pgPool);
    cams = createPgCamStore(pgPool);
    jobRuns = createPgJobRunStore(pgPool);
    releases = createPgReleaseStore(pgPool);
    authBackend = new PgAuthBackend(pgPool);
  } else {
    if (!injected) {
      console.warn("未配置 DATABASE_URL：降级为进程内内存 store（仅开发/测试；生产必须配置 DATABASE_URL）。登录走 bootstrap 单账号。");
    }
    authBackend = new BootstrapAuthBackend(config.auth.bootstrap);
  }

  let auditSink: AuditSink;
  if (config.auditSink === "pg" && pgPool) {
    auditSink = new PgAuditSink(pgPool);
  } else if (config.auditSink === "file") {
    auditSink = new FileAuditSink(join(config.storage.dataDir, "audit.log"));
  } else {
    auditSink = new MemoryAuditSink();
  }

  const loginService = new LoginService(pgPool, authBackend, config.login, auditSink);
  const aiPlans = createAiPlanStore();
  const partsAnalyzer =
    deps.partsAnalyzer ??
    (config.partsAnalyzer.mode === "worker"
      ? createWorkerAnalyzer(config.partsAnalyzer.binaryPath ?? "geometry_worker")
      : createFixtureAnalyzer(config.partsAnalyzer.fixturesDir));
  const auth = createAuth(config.jwt);
  const llmGateway = buildLlmGateway(config.ai);
  const metrics = new MetricsRegistry();
  const authorize = authorizeFactory(auditSink);

  // 订阅作业生命周期事件 → jobs_completed_total
  bus.subscribe(null, (ev) => {
    const t = ev.type;
    if (t === "job.failed") metrics.recordJob("failed");
    else if (t.endsWith(".completed") || t === "job.released") metrics.recordJob("completed");
  });

  // ---- 中间件注册（顺序：DI → 上下文 → 指标 → CORS → CSP → 鉴权 → 路由）----
  // DI：把业务服务一次性 set 到每个请求的 Variables
  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("storage", storage);
    c.set("bus", bus);
    c.set("jobs", jobs);
    c.set("parts", parts);
    c.set("partsAnalyzer", partsAnalyzer);
    c.set("cams", cams);
    c.set("jobRuns", jobRuns);
    c.set("releases", releases);
    c.set("aiPlans", aiPlans);
    c.set("authBackend", authBackend);
    c.set("aiLlm", config.ai.llmLive);
    c.set("llmGateway", llmGateway);
    c.set("auditSink", auditSink);
    c.set("loginService", loginService);
    c.set("metrics", metrics);
    c.set("bootstrap", config.auth.bootstrap);
    c.set("authorize", authorize);
    c.set("auth", auth);
    await next();
  });

  app.use("*", requestContextMiddleware());
  app.use("*", metricsMiddleware(metrics));
  app.use(
    "*",
    cors({
      origin: (o) => (o && config.corsOrigins.includes(o) ? o : undefined),
      credentials: true,
    }),
  );
  app.use("*", cspMiddleware());
  app.use("*", authMiddleware());

  // /metrics 端点（由 handler 内 METRICS_TOKEN 鉴权）
  app.get("/metrics", metricsHandler(metrics, config.metricsToken));

  // 启动告警（开发态默认值）
  if (config.jwt.usingDefault) {
    console.warn("使用默认开发态 JWT_SECRET。生产必须配置 JWT_SECRET。");
  }
  if (!config.databaseUrl && !injected && config.auth.bootstrap.usingDefaults) {
    console.warn(
      `使用默认开发态 bootstrap 凭据（${config.auth.bootstrap.email} / demo，org=${config.auth.bootstrap.orgId}）。生产请配置 DATABASE_URL + ADMIN_EMAIL/ADMIN_PASSWORD，或 CAM_BOOTSTRAP_PASSWORD(_HASH)。`,
    );
  }

  // ---- 路由 ----
  registerRoutes(app, authorize);

  app.onError(errorHandler);

  return app;
}
