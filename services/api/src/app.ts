/** App 工厂：测试可注入 storage/bus/jobs；生产用 loadConfig() */
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { InMemoryEventBus, EventBus } from "./bus/event-bus.js";
import { createJobStore, JobStore } from "./jobs/job-store.js";
import { createPartStore, PartStore } from "./parts/part-store.js";
import { createCamStore, CamStore } from "./cam/cam-store.js";
import { createJobRunStore, JobRunStore } from "./cam/job-run-store.js";
import { createReleaseStore, type ReleaseStore } from "./cam/release-store.js";
import { createAiPlanStore, type AiPlanStore } from "./cam/ai-plan-store.js";
import { createFixtureAnalyzer, createWorkerAnalyzer, type PartAnalyzer } from "./parts/analyzer.js";
import { R2Adapter } from "./storage/r2-adapter.js";
import { LocalDiskAdapter } from "./storage/local-adapter.js";
import { StorageAdapter } from "./storage/storage.js";
import { authPlugin } from "./plugins/auth.js";
import securityPlugin from "./plugins/security.js";
import errorHandlerPlugin from "./plugins/error-handler.js";
import requestContext from "./plugins/request-context.js";
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
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import eventRoutes from "./routes/events.js";
import fileRoutes from "./routes/files.js";
import jobRoutes from "./routes/jobs.js";
import partRoutes from "./routes/parts.js";
import masterRoutes from "./routes/master.js";
import { ModelGateway } from "@ai-cam/model-gateway";
import { buildLlmGateway } from "./llm/build-gateway.js";

declare module "fastify" {
  interface FastifyInstance {
    storage: StorageAdapter;
    bus: EventBus;
    jobs: JobStore;
    parts: PartStore;
    partsAnalyzer: PartAnalyzer;
    cams: CamStore;
    jobRuns: JobRunStore;
    releases: ReleaseStore;
    aiPlans: AiPlanStore;
    /** Phase 0 bootstrap 登录凭据（服务端解算 org_id/role；仅内存降级路径） */
    bootstrap: AppConfig["auth"]["bootstrap"];
    /** P0-03：登录凭据校验后端（内存降级 = bootstrap 单账号；PG = users/memberships） */
    authBackend: AuthBackend;
    /** P1-17：AI 规划是否接入真实 LLM（否则 MockProvider） */
    aiLlm: boolean;
    /** P1-06：装配好的 LLM 网关（真实 provider 承担任务，mock 作优雅回退；无 key 时仅 mock） */
    llmGateway: ModelGateway;
  }
}

export interface AppDeps {
  config?: AppConfig;
  storage?: StorageAdapter;
  bus?: EventBus;
  jobs?: JobStore;
  parts?: PartStore;
  partsAnalyzer?: PartAnalyzer;
  cams?: CamStore;
  jobRuns?: JobRunStore;
  releases?: ReleaseStore;
}

export async function buildApp(deps: AppDeps = {}): Promise<FastifyInstance> {
  const config = deps.config ?? loadConfig();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization"],
    },
    genReqId: () => `req_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    // P2-42：bodyLimit 由 config 注入（默认 64MB，BODY_LIMIT_BYTES 可覆盖；原 512MB 过宽）
    bodyLimit: config.bodyLimitBytes,
    // 允许 OpenAPI 扩展关键字（tags 等）进入 route schema，供 @fastify/swagger 生成文档
    ajv: { customOptions: { strict: false } },
  });

  // P2-40：CORS 仅放行白名单 Origin；@fastify/cors 对不在列表中的 Origin 不回 ACAO 头
  await app.register(cors, { origin: config.corsOrigins });
  await app.register(helmet, { contentSecurityPolicy: false });
  // P2-41：手工设置 CSP（不新增 helmet 依赖；helmet 其余安全头仍生效）
  const CSP =
    "default-src 'self'; script-src 'self'; connect-src 'self' http://localhost:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:";
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("content-security-policy", CSP);
    return payload;
  });
  await app.register(swagger, {
    openapi: {
      info: { title: "AI CNC CAM API", version: "0.1.0", description: "Phase 0 骨架" },
      servers: [{ url: "http://localhost:8080" }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // P1-04：导出 OpenAPI 3.1 原始 spec（从 route schema/ajv 提取；契约测试与 CI 快照比对用）。
  // 鉴权插件对 /docs 与 /docs/* 放行，故该端点公开可读。
  app.get("/docs/openapi.json", async (_req, reply) => {
    reply.header("content-type", "application/json; charset=utf-8");
    return app.swagger();
  });

  // 原始二进制解析（上传端点）
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  await app.register(requestContext);
  await app.register(authPlugin(config.jwt));

  // 依赖注入
  const bus = deps.bus ?? new InMemoryEventBus();
  const storage =
    deps.storage ??
    (config.storage.driver === "r2" && config.storage.r2
      ? new R2Adapter(config.storage.r2)
      : new LocalDiskAdapter(config.storage.dataDir));

  // P0-01：数据源选择（提前到插件注册前，以便按 config.auditSink 选审计 sink）。
  // - 显式注入 store（测试注入路径）→ 用注入；
  // - 配置 DATABASE_URL → 生产走 PostgreSQL（建池 + 跑迁移 + 播种 bootstrap 管理员 + PG stores + PgAuthBackend）；
  // - 否则降级为进程内内存 store（仅开发/测试），启动打 WARN。
  const injected = Boolean(deps.parts ?? deps.jobs ?? deps.cams ?? deps.jobRuns ?? deps.releases);
  let pgPool: import("pg").Pool | undefined;
  let jobs: JobStore = deps.jobs ?? createJobStore(bus);
  let parts: PartStore = deps.parts ?? createPartStore();
  let cams: CamStore = deps.cams ?? createCamStore();
  let jobRuns: JobRunStore = deps.jobRuns ?? createJobRunStore();
  let releases: ReleaseStore = deps.releases ?? createReleaseStore();
  let authBackend: AuthBackend;

  if (!injected && config.databaseUrl) {
    app.log.info("DATABASE_URL 已配置，使用 PostgreSQL 持久层。");
    pgPool = createPool(config.databaseUrl);
    try {
      await runMigrations(pgPool, { logger: { info: (m, meta) => app.log.info({ meta }, m), warn: (m, meta) => app.log.warn({ meta }, m) } });
      await seedBootstrapAdmin(pgPool, config);
      app.log.info("数据库迁移与 bootstrap 管理员播种完成。");
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
      app.log.warn(
        "未配置 DATABASE_URL：降级为进程内内存 store（仅开发/测试；生产必须配置 DATABASE_URL）。登录走 bootstrap 单账号。",
      );
    }
    authBackend = new BootstrapAuthBackend(config.auth.bootstrap);
  }

  // P1-08：按 config.auditSink（memory|file|pg）选审计 sink；缺省 memory 保测试。
  // - pg：仅在 PG 模式（pgPool 存在）生效，否则回退 memory；
  // - file：JSONL 落到 dataDir/audit.log；
  // - memory：进程内（默认）。
  let auditSink: AuditSink;
  if (config.auditSink === "pg" && pgPool) {
    auditSink = new PgAuditSink(pgPool);
  } else if (config.auditSink === "file") {
    auditSink = new FileAuditSink(join(config.storage.dataDir, "audit.log"));
  } else {
    auditSink = new MemoryAuditSink();
  }
  // P0-4：RBAC 授权 preHandler + 审计 sink（依赖 authPlugin 设置 request.user）
  await app.register(securityPlugin, { auditSink });
  await app.register(errorHandlerPlugin);

  const aiPlans = createAiPlanStore(); // ai_plans 落库可后置，保持内存实现
  const partsAnalyzer =
    deps.partsAnalyzer ??
    (config.partsAnalyzer.mode === "worker"
      ? createWorkerAnalyzer(config.partsAnalyzer.binaryPath ?? "geometry_worker")
      : createFixtureAnalyzer(config.partsAnalyzer.fixturesDir));
  app.decorate("bus", bus);
  app.decorate("storage", storage);
  app.decorate("jobs", jobs);
  app.decorate("parts", parts);
  app.decorate("cams", cams);
  app.decorate("partsAnalyzer", partsAnalyzer);
  app.decorate("jobRuns", jobRuns);
  app.decorate("releases", releases);
  app.decorate("aiPlans", aiPlans);
  // P0-1：登录路由读取的服务端 bootstrap 凭据（仅内存降级路径使用）
  app.decorate("bootstrap", config.auth.bootstrap);
  // P0-03：登录凭据校验后端
  app.decorate("authBackend", authBackend);
  // P1-17：AI 规划是否接入真实 LLM（响应头 x-ai-mode 据此标注 live/mock）
  app.decorate("aiLlm", config.ai.llmLive);
  // P1-06：LLM 网关（真实 provider 承担任务；无 key 时仅 mock，失败自动降级）
  app.decorate("llmGateway", buildLlmGateway(config.ai));
  // P2-43：未显式配置 JWT_SECRET（走开发默认值）时告警；生产未配置已在 loadConfig 抛错
  if (config.jwt.usingDefault) {
    app.log.warn("使用默认开发态 JWT_SECRET。生产必须配置 JWT_SECRET（loadConfig 在 NODE_ENV=production 未设置时直接拒绝启动）。");
  }
  // 未配置正式凭据时启动告警（仅开发态默认 demo/demo；PG 模式此分支不触发）
  if (!config.databaseUrl && !injected && config.auth.bootstrap.usingDefaults) {
    app.log.warn(
      `使用默认开发态 bootstrap 凭据（${config.auth.bootstrap.email} / demo，org=${config.auth.bootstrap.orgId}）。生产请配置 DATABASE_URL + ADMIN_EMAIL/ADMIN_PASSWORD，或 CAM_BOOTSTRAP_PASSWORD(_HASH)。`,
    );
  }

  // 路由
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(fileRoutes, { prefix: "/api/v1/files" });
  await app.register(jobRoutes, { prefix: "/api/v1/jobs" });
  await app.register(partRoutes, { prefix: "/api/v1/parts" });
  await app.register(masterRoutes, { prefix: "/api/v1/master" });
  await app.register(eventRoutes, { prefix: "/api/v1/events" });

  app.addHook("onClose", async () => {
    app.log.info("api shutting down");
    if (pgPool) await pgPool.end().catch(() => undefined);
  });

  return app;
}
