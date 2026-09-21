/**
 * P2-01 /metrics 契约与行为测试（不引 OTel）。
 * - Prometheus 文本格式：含 http_requests_total / http_request_duration_ms / http_errors_total / jobs_completed_total。
 * - 埋点：请求后计数器增长；route 用路由模板（低基数）。
 * - METRICS_TOKEN 鉴权：配置后无 token → 401，正确 Bearer → 200。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { LocalDiskAdapter } from "./storage/local-adapter.js";
import { InMemoryEventBus } from "./bus/event-bus.js";

const FIXTURES_DIR = resolve(process.cwd(), "../../tests/golden/parts");

describe("P2-01 /metrics Prometheus 端点", () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ai-cam-metrics-"));
    const config = loadConfig({ PORT: "8080", JWT_SECRET: "test-secret", DATA_DIR: dataDir, PARTS_ANALYZER: "fixture", FIXTURES_DIR: FIXTURES_DIR });
    app = await buildApp({ config, bus: new InMemoryEventBus(), storage: new LocalDiskAdapter(dataDir) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("返回 Prometheus 文本格式，含四类指标", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/plain");
    const body = res.body;
    expect(body).toContain("# TYPE http_requests_total counter");
    expect(body).toContain("# TYPE http_request_duration_ms histogram");
    expect(body).toContain("# TYPE http_errors_total counter");
    expect(body).toContain("# TYPE jobs_completed_total counter");
  });

  it("请求后 http_requests_total 按 method/route/status 增长", async () => {
    await app.inject({ method: "GET", url: "/health" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toMatch(/http_requests_total\{method="GET",route="\/health",status="200"\} \d+/);
    // 直方图已记录 /health 的延迟
    expect(res.body).toMatch(/http_request_duration_ms_count\{method="GET",route="\/health"\} \d+/);
  });
});

describe("P2-01 /metrics METRICS_TOKEN 鉴权", () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ai-cam-metrics-auth-"));
    const config = loadConfig({
      PORT: "8080",
      JWT_SECRET: "test-secret",
      DATA_DIR: dataDir,
      PARTS_ANALYZER: "fixture",
      FIXTURES_DIR: FIXTURES_DIR,
      METRICS_TOKEN: "secret-scrape-token",
    });
    app = await buildApp({ config, bus: new InMemoryEventBus(), storage: new LocalDiskAdapter(dataDir) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("未带 token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
  });

  it("正确 Bearer token → 200 指标体", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer secret-scrape-token" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("http_requests_total");
  });

  it("?token= 查询参数也可鉴权", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics?token=secret-scrape-token" });
    expect(res.statusCode).toBe(200);
  });
});
