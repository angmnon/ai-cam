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
    bodyLimit: 512 * 1024 * 1024,
    // 允许 OpenAPI 扩展关键字（tags 等）进入 route schema，供 @fastify/swagger 生成文档
    ajv: { customOptions: { strict: false } },
  });

  await app.register(cors, { origin: true });
  await app.register(helmet, { contentSecurityPolicy: false });
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
