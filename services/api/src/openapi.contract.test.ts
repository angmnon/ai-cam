/**
 * P1-04：OpenAPI 3.1 契约测试。
 *
 * - 从运行中的 Fastify 实例拉取 /docs/openapi.json（@fastify/swagger 从 route schema/ajv 提取，非手写全量 spec）。
 * - 对关键端点断言：路径存在、请求体 required 字段、参数、响应码。
 * - 再跑一条最小 live 流程，断言响应信封与字段与契约一致。
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryEventBus } from "./bus/event-bus.js";
import { LocalDiskAdapter } from "./storage/local-adapter.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const FIXTURES_DIR = resolve(process.cwd(), "../../tests/golden/parts");
const fixturesAvailable = existsSync(FIXTURES_DIR) && readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json")).length >= 8;

interface OpenApiDoc {
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
}

describe("P1-04 OpenAPI 3.1 契约", () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ai-cam-oaspec-"));
    const config = loadConfig({ PORT: "8080", JWT_SECRET: "test-secret", DATA_DIR: dataDir, PARTS_ANALYZER: "fixture", FIXTURES_DIR: FIXTURES_DIR });
    app = await buildApp({ config, bus: new InMemoryEventBus(), storage: new LocalDiskAdapter(dataDir) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function fetchSpec(): Promise<OpenApiDoc> {
    const res = await app.inject({ method: "GET", url: "/docs/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/json");
    return res.json() as OpenApiDoc;
  }

  it("暴露 OpenAPI 3.1 文档", async () => {
    const spec = await fetchSpec();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths).toBeTruthy();
  });

  it("关键端点均在 spec 中登记", async () => {
    const spec = await fetchSpec();
    const paths = spec.paths ?? {};
    const expected: Array<[string, string]> = [
      ["/api/v1/auth/login", "post"],
      ["/api/v1/parts/", "post"],
      ["/api/v1/parts/", "get"],
      ["/api/v1/parts/{id}/analyze", "post"],
      ["/api/v1/jobs/", "post"],
      ["/api/v1/parts/{id}/release", "post"],
    ];
    for (const [p, method] of expected) {
      expect(paths[p], `missing path ${p}`).toBeTruthy();
      expect((paths[p] as Record<string, unknown>)[method], `missing ${method} on ${p}`).toBeTruthy();
    }
  });

  it("POST /auth/login 请求体契约：email+password 必填", async () => {
    const spec = await fetchSpec();
    const op = (spec.paths?.["/api/v1/auth/login"] as Record<string, Record<string, unknown>>).post as {
      requestBody?: { content: { "application/json": { schema: { required?: string[] } } } };
    };
    const required = op.requestBody?.content["application/json"].schema.required ?? [];
    expect(required).toEqual(expect.arrayContaining(["email", "password"]));
  });

  it("POST /parts 请求体契约：filename+size_bytes 必填", async () => {
    const spec = await fetchSpec();
    const op = (spec.paths?.["/api/v1/parts/"] as Record<string, Record<string, unknown>>).post as {
      requestBody?: { content: { "application/json": { schema: { required?: string[] } } } };
    };
    const required = op.requestBody?.content["application/json"].schema.required ?? [];
    expect(required).toEqual(expect.arrayContaining(["filename", "size_bytes"]));
  });

  it("POST /jobs 请求体契约：input 必填", async () => {
    const spec = await fetchSpec();
    const op = (spec.paths?.["/api/v1/jobs/"] as Record<string, Record<string, unknown>>).post as {
      requestBody?: { content: { "application/json": { schema: { required?: string[] } } } };
    };
    const required = op.requestBody?.content["application/json"].schema.required ?? [];
    expect(required).toContain("input");
  });

  it("POST /parts/{id}/analyze 契约：path 参数 id 必填", async () => {
    const spec = await fetchSpec();
    const op = (spec.paths?.["/api/v1/parts/{id}/analyze"] as Record<string, Record<string, unknown>>).post as {
      parameters?: Array<{ name: string; required: boolean }>;
    };
    const idParam = (op.parameters ?? []).find((p) => p.name === "id");
    expect(idParam).toBeTruthy();
    expect(idParam?.required).toBe(true);
  });

  it("live 流程响应信封与契约一致", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "demo@ai-cam.local", password: "demo" },
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json().data as { token: string }).token;
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers: auth, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.part.id).toMatch(/^part_/);

    const listed = await app.inject({ method: "GET", url: "/api/v1/parts", headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().meta.total).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!fixturesAvailable)("P1-04 契约：analyze/release live 字段", () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ai-cam-oaspec2-"));
    const config = loadConfig({ PORT: "8080", JWT_SECRET: "test-secret", DATA_DIR: dataDir, PARTS_ANALYZER: "fixture", FIXTURES_DIR: FIXTURES_DIR });
    app = await buildApp({ config, storage: new LocalDiskAdapter(dataDir) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("analyze → ANALYZED；release 创建 → PENDING_APPROVAL", async () => {
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "demo@ai-cam.local", password: "demo" } });
    const auth = { authorization: `Bearer ${(login.json().data as { token: string }).token}` };

    const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers: auth, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
    const partId = created.json().data.part.id;

    const analyzed = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/analyze`, headers: auth });
    expect(analyzed.statusCode).toBe(200);
    expect(analyzed.json().data.status).toBe("ANALYZED");

    // 先 toolpath + job，release 才成立
    await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/toolpath`, headers: auth });
    await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/job`, headers: auth });
    const rel = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/release`, headers: auth });
    expect(rel.statusCode).toBe(201);
    expect(rel.json().data.status).toBe("PENDING_APPROVAL");
    expect(rel.json().data.id).toMatch(/^rel_/);
  });
});
