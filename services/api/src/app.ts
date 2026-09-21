/** App 工厂：测试可注入 storage/bus/jobs；生产用 loadConfig() */
import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
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
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import eventRoutes from "./routes/events.js";
import fileRoutes from "./routes/files.js";
import jobRoutes from "./routes/jobs.js";
import partRoutes from "./routes/parts.js";
import masterRoutes from "./routes/master.js";

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
    /** Phase 0 bootstrap 登录凭据（服务端解算 org_id/role） */
    bootstrap: AppConfig["auth"]["bootstrap"];
    /** P1-17：AI 规划是否接入真实 LLM（否则 MockProvider） */
    aiLlm: boolean;
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

  // 原始二进制解析（上传端点）
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  await app.register(requestContext);
  await app.register(authPlugin(config.jwt));
  // P0-4：RBAC 授权 preHandler 工厂 + 内存审计 sink（依赖 authPlugin 设置 request.user）
  await app.register(securityPlugin);
  await app.register(errorHandlerPlugin);

  // 依赖注入
  const bus = deps.bus ?? new InMemoryEventBus();
  const storage =
    deps.storage ?? (config.storage.driver === "r2" ? new R2Adapter({ accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "", publicUrl: "" }) : new LocalDiskAdapter(config.storage.dataDir));
  const jobs = deps.jobs ?? createJobStore(bus);
  const parts = deps.parts ?? createPartStore();
  const cams = deps.cams ?? createCamStore();
  const jobRuns = deps.jobRuns ?? createJobRunStore();
  const releases = createReleaseStore();
  const aiPlans = createAiPlanStore();
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
  // P0-1：登录路由读取的服务端 bootstrap 凭据
  app.decorate("bootstrap", config.auth.bootstrap);
  // P1-17：AI 规划是否接入真实 LLM（响应头 x-ai-mode 据此标注 live/mock）
  app.decorate("aiLlm", config.ai.llmLive);
  // P2-43：未显式配置 JWT_SECRET（走开发默认值）时告警；生产未配置已在 loadConfig 抛错
  if (config.jwt.usingDefault) {
    app.log.warn("使用默认开发态 JWT_SECRET。生产必须配置 JWT_SECRET（loadConfig 在 NODE_ENV=production 未设置时直接拒绝启动）。");
  }
  // 未配置正式凭据时启动告警（仅开发态默认 demo/demo）
  if (config.auth.bootstrap.usingDefaults) {
    app.log.warn(
      `使用默认开发态 bootstrap 凭据（${config.auth.bootstrap.email} / demo，org=${config.auth.bootstrap.orgId}）。生产请配置 CAM_BOOTSTRAP_PASSWORD 或 CAM_BOOTSTRAP_PASSWORD_HASH。`,
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
  });

  return app;
}
