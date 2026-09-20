/** API 骨架集成测试（vitest + fastify inject） */
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
import { attachSseStream } from "./routes/events.js";

const FIXTURES_DIR = resolve(process.cwd(), "../../tests/golden/parts");
const fixturesAvailable = existsSync(FIXTURES_DIR) && readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json")).length >= 8;

describe("api skeleton", () => {
  let app: FastifyInstance;
  let bus: InMemoryEventBus;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ai-cam-"));
    bus = new InMemoryEventBus();
    const config = loadConfig({ PORT: "8080", JWT_SECRET: "test-secret", DATA_DIR: dataDir });
    app = await buildApp({ config, bus, storage: new LocalDiskAdapter(dataDir) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function login(orgId = "org_demo"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "engineer@test.local", password: "x", organization_id: orgId },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data as { token: string }).token;
  }

  function authHeaders(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  it("GET /health 返回服务状态", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("ok");
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("未携带 token 访问受保护路由 → 401 AUTH_UNAUTHORIZED", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/jobs" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("AUTH_UNAUTHORIZED");
  });

  it("登录成功返回 Bearer token，并可用", async () => {
    const token = await login();
    const res = await app.inject({ method: "GET", url: "/api/v1/jobs", headers: authHeaders(token) });
    expect(res.statusCode).toBe(200);
  });

  it("创建 Job → 合法流转 → 发布进度事件", async () => {
    const token = await login();
    const events: string[] = [];
    bus.subscribe(null, (e) => events.push(e.type));

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: authHeaders(token),
      payload: {
        input: {
          part_id: "part_1",
          machine_id: "m_vmc_3axis",
          controller_id: "c_fanuc",
          material_id: "mat_6061",
          axis_mode: "3AXIS",
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json().data;
    expect(job.status).toBe("DRAFT");
    expect(job.id).toMatch(/^job_/);
    expect(events).toContain("job.created");

    const ok1 = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${job.id}/transition`,
      headers: authHeaders(token),
      payload: { to: "UPLOADING", reason: "uploading source step" },
    });
    expect(ok1.statusCode).toBe(200);
    expect(ok1.json().data.status).toBe("UPLOADING");
    expect(events).toContain("job.progress");

    const ok2 = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${job.id}/transition`,
      headers: authHeaders(token),
      payload: { to: "PARSING" },
    });
    expect(ok2.statusCode).toBe(200);
    expect(ok2.json().data.version).toBe(2);
  });

  it("非法跳转 DRAFT → RELEASED → 409 JOB_STATE_INVALID", async () => {
    const token = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: authHeaders(token),
      payload: { input: { part_id: "p", machine_id: "m", controller_id: "c", material_id: "mat" } },
    });
    const job = created.json().data;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${job.id}/transition`,
      headers: authHeaders(token),
      payload: { to: "RELEASED" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("JOB_STATE_INVALID");
  });

  it("失败上报 → FAILED + job.failed 事件", async () => {
    const token = await login();
    const events: string[] = [];
    bus.subscribe(null, (e) => events.push(e.type));

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: authHeaders(token),
      payload: { input: { part_id: "p", machine_id: "m", controller_id: "c", material_id: "mat" } },
    });
    const jobId = created.json().data.id;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/${jobId}/fail`,
      headers: authHeaders(token),
      payload: { code: "CAD_PARSE_FAILED", message: "STEP parse error", stage: "geometry", retryable: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("FAILED");
    expect(res.json().data.failure.code).toBe("CAD_PARSE_FAILED");
    expect(events).toContain("job.failed");
  });

  it("多租户隔离：org_b 无法读取 org_a 的 Job", async () => {
    const tokenA = await login("org_a");
    const tokenB = await login("org_b");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/jobs",
      headers: authHeaders(tokenA),
      payload: { input: { part_id: "p", machine_id: "m", controller_id: "c", material_id: "mat" } },
    });
    const jobId = created.json().data.id;

    const denied = await app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}`, headers: authHeaders(tokenB) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("AUTH_FORBIDDEN");

    const listA = await app.inject({ method: "GET", url: "/api/v1/jobs", headers: authHeaders(tokenA) });
    expect(listA.json().meta.total).toBe(1);
    const listB = await app.inject({ method: "GET", url: "/api/v1/jobs", headers: authHeaders(tokenB) });
    expect(listB.json().meta.total).toBe(0);
  });

  it("上传会话 → 实际上传 → 文件写入与 SHA-256 记录", async () => {
    const token = await login();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload-sessions",
      headers: authHeaders(token),
      payload: {
        filename: "part-a.step",
        content_type: "model/step",
        size_bytes: 1234,
        resource_type: "CAD_SOURCE",
        resource_id: "part_1",
        version: "v0",
      },
    });
    expect(session.statusCode).toBe(200);
    const s = session.json().data;
    expect(s.upload_url).toContain("/api/v1/files/upload");
    expect(s.method).toBe("POST");

    const body = Buffer.from("ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
    const upload = await app.inject({
      method: "POST",
      url: "/api/v1/files/upload",
      headers: { ...authHeaders(token), "x-file-id": s.file_id, "x-file-key": "org_demo/cad_source/part_1/v0/part-a.step", "content-type": "application/octet-stream" },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const meta = upload.json().data;
    expect(meta.sha256).toHaveLength(64);
    expect(meta.size_bytes).toBe(body.length);

    const stored = await app.storage.get("org_demo/cad_source/part_1/v0/part-a.step");
    expect(stored.data.toString()).toContain("ISO-10303-21");
  });

  it("SSE 流：订阅后发布事件即输出标准帧", () => {
    const writes: string[] = [];
    const fakeRes = {
      writeHead: () => undefined,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
    } as unknown as import("node:http").ServerResponse;

    const cleanup = attachSseStream({ raw: fakeRes }, bus, "job_123", 60_000);
    bus.publishFor("com.aicam.test", "job.progress", "job_123", { status: "PARSING", progress: 20 });
    expect(writes.some((w) => w.includes("event: job.progress"))).toBe(true);
    expect(writes.some((w) => w.includes('"subject":"job_123"'))).toBe(true);
    cleanup();
  });

  it("主数据路由返回种子数据", async () => {
    const token = await login();
    for (const path of ["machines", "controllers", "tools", "materials", "cutting-rules"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/master/${path}`, headers: authHeaders(token) });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().data)).toBe(true);
      expect(res.json().data.length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!fixturesAvailable)("api parts pipeline（fixture 模式）", () => {
  let app: FastifyInstance;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ai-cam-parts-"));
    const config = loadConfig({ PORT: "8080", JWT_SECRET: "test-secret", DATA_DIR: dataDir, PARTS_ANALYZER: "fixture", FIXTURES_DIR: FIXTURES_DIR });
    app = await buildApp({ config, storage: new LocalDiskAdapter(dataDir) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "e@test.local", password: "x" } });
    return (res.json().data as { token: string }).token;
  }

  it("创建零件（CAD_SOURCE 会话）→ 分析 → 特征/DFM → 网格", async () => {
    const token = await login();
    const headers = { authorization: `Bearer ${token}` };

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/parts",
      headers,
      payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 },
    });
    expect(created.statusCode).toBe(201);
    const part = created.json().data.part;
    expect(part.id).toMatch(/^part_/);
    expect(part.status).toBe("PENDING");
    expect(part.source_key).toContain(`cad_source/${part.id}`);

    const analyzed = await app.inject({ method: "POST", url: `/api/v1/parts/${part.id}/analyze`, headers });
    expect(analyzed.statusCode).toBe(200);
    const after = analyzed.json().data;
    expect(after.status).toBe("ANALYZED");
    expect(after.analysis.part.volume_mm3).toBeCloseTo(120000, 0);
    expect(after.analysis.part.bbox_mm.max).toEqual([80, 50, 30]);

    const feats = await app.inject({ method: "GET", url: `/api/v1/parts/${part.id}/features`, headers });
    expect(feats.statusCode).toBe(200);
    const types = feats.json().data.features.map((f: { type: string }) => f.type);
    expect(types).toContain("OUTER_PROFILE");

    const dfm = await app.inject({ method: "GET", url: `/api/v1/parts/${part.id}/dfm`, headers });
    expect(dfm.statusCode).toBe(200);
    expect(dfm.json().data.rules_version).toMatch(/^\d+\.\d+\.\d+$/);

    const mesh = await app.inject({ method: "GET", url: `/api/v1/parts/${part.id}/mesh`, headers });
    if (after.analysis.mesh_key) {
      expect(mesh.statusCode).toBe(200);
      expect(String(mesh.headers["content-type"])).toBe("model/obj");
    } else {
      expect(mesh.statusCode).toBe(404);
    }
  });

  it("多租户隔离：org_b 无法读取 org_a 的零件", async () => {
    const ta = await login();
    const tbRes = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "e@test.local", password: "x", organization_id: "org_b" } });
    const tb = (tbRes.json().data as { token: string }).token;

    const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers: { authorization: `Bearer ${ta}` }, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
    const partId = created.json().data.part.id;

    const denied = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}`, headers: { authorization: `Bearer ${tb}` } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("AUTH_FORBIDDEN");
  });

  it("未知零件分析 → 404 PART_NOT_FOUND；未分析前 features → 409", async () => {
    const token = await login();
    const headers = { authorization: `Bearer ${token}` };
    const nf = await app.inject({ method: "GET", url: "/api/v1/parts/part_nope", headers });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe("PART_NOT_FOUND");

    const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
    const partId = created.json().data.part.id;
    const feats = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/features`, headers });
    expect(feats.statusCode).toBe(409);
    expect(feats.json().error.code).toBe("PART_STATE_INVALID");
  });

  it("生成 CAM 工艺计划（box）：POST toolpath → CamIR 校验 → GET 最新", async () => {
    const token = await login();
    const headers = { authorization: `Bearer ${token}` };

    const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
    const partId = created.json().data.part.id;
    await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/analyze`, headers });

    // 未生成前 GET → 404 CAM_REVISION_NOT_FOUND
    const pre = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/toolpath`, headers });
    expect(pre.statusCode).toBe(404);
    expect(pre.json().error.code).toBe("CAM_REVISION_NOT_FOUND");

    const gen = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/toolpath`, headers });
    expect(gen.statusCode).toBe(201);
    const data = gen.json().data;
    expect(data.revision.id).toMatch(/^cam_/);
    expect(data.revision.revision_no).toBe(1);
    expect(data.cam.schema_version).toBe("1.0.0");
    expect(data.cam.operations.length).toBeGreaterThanOrEqual(2);
    expect(data.cam.tools.length).toBeGreaterThan(0);
    expect(data.cam.setups[0].wcs).toBe("G54");
    expect(data.cam.toolpaths.length).toBe(data.cam.operations.length);
    for (const tp of data.cam.toolpaths) {
      expect(tp.move_count).toBe(tp.moves.length);
      expect(tp.moves.every((m: { x: number; y: number; z: number }) => Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z))).toBe(true);
      expect(tp.bounds.min.x).toBeLessThanOrEqual(tp.bounds.max.x);
    }
    expect(data.parameter_decisions.FACE_F0001.parameters.feed_mm_min).toBeGreaterThan(0);

    const latest = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/toolpath`, headers });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().data.revision_no).toBe(1);
  });

  it("一键 Job（box）：POST /job → Validated NC → GET nc/validation", async () => {
    const token = await login();
    const headers = { authorization: `Bearer ${token}` };

    const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
    const partId = created.json().data.part.id;
    await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/analyze`, headers });

    // 未生成前 GET → 404
    const pre = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/job`, headers });
    expect(pre.statusCode).toBe(404);

    const run = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/job`, headers });
    expect(run.statusCode).toBe(201);
    const data = run.json().data;
    expect(data.job.id).toMatch(/^jobrun_/);
    expect(data.job.validated).toBe(true);
    expect(data.job.pipeline.map((p: { stage: string }) => p.stage)).toEqual(["PLAN", "SIMULATE", "POST", "VALIDATE"]);
    for (const p of data.job.pipeline) expect(p.status).toBe("PASS");
    expect(data.nc.program_number).toMatch(/^O\d{4}$/);
    expect(data.nc.line_count).toBeGreaterThan(20);
    expect(data.simulation.status).toBe("PASS");
    expect(data.validation.status).toBe("PASS");
    expect(data.validation.layers.length).toBe(4);

    // 最新 Job
    const latest = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/job`, headers });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().data.run.validated).toBe(true);

    // NC 文本
    const nc = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/job/nc`, headers });
    expect(nc.statusCode).toBe(200);
    expect(String(nc.headers["content-type"])).toContain("text/plain");
    expect(nc.body).toContain("G21 G17 G90 G94");
    expect(nc.body).toContain("M30");

    // 校验报告
    const val = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/job/validation`, headers });
    expect(val.statusCode).toBe(200);
    expect(val.json().data.status).toBe("PASS");
    expect(val.json().data.layers.map((l: { layer: string }) => l.layer)).toEqual(["PARSER", "SEMANTIC", "MACHINE", "SIMULATION"]);

    // Job 报告（P3-9）
    const rep = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/job/report`, headers });
    expect(rep.statusCode).toBe(200);
    const report = rep.json().data;
    expect(report.schema_version).toBe("1.0.0");
    expect(report.program_number).toMatch(/^O\d{4}$/);
    expect(report.validated).toBe(true);
    expect(report.setup_sheet[0].wcs).toBe("G54");
    expect(report.tool_list.length).toBeGreaterThan(0);
    expect(report.process_sheet.length).toBe(report.summary.operation_count);
    expect(report.simulation.status).toBe("PASS");
    expect(report.simulation.removed_volume_mm3).toBeGreaterThan(0);
  });

  describe("Release 工作流（P4-11）", () => {
    async function buildPartWithJob() {
      const token = await login();
      const headers = { authorization: `Bearer ${token}` };
      const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
      const partId = created.json().data.part.id;
      await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/analyze`, headers });
      await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/toolpath`, headers });
      const run = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/job`, headers });
      expect(run.statusCode).toBe(201);
      return { token, headers, partId };
    }

    it("无 Job 时创建 Release → 409 JOB_NOT_FOUND", async () => {
      const token = await login();
      const headers = { authorization: `Bearer ${token}` };
      const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
      const partId = created.json().data.part.id;
      await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/analyze`, headers });
      const rel = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/release`, headers });
      expect(rel.statusCode).toBe(404);
      expect(rel.json().error.code).toBe("JOB_NOT_FOUND");
    });

    it("创建→审批→发布完整链：version 递增 + 二维码 + 审计", async () => {
      const { headers, partId } = await buildPartWithJob();

      const created = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/release`, headers });
      expect(created.statusCode).toBe(201);
      const rel = created.json().data;
      expect(rel.id).toMatch(/^rel_/);
      expect(rel.version_no).toBe(1);
      expect(rel.status).toBe("PENDING_APPROVAL");
      expect(rel.qr_token).toMatch(/^qr_/);
      expect(rel.cam_revision_id).toMatch(/^cam_/);
      expect(rel.job_run_id).toMatch(/^jobrun_/);

      // 未审批直接发布 → 409 RELEASE_STATE_INVALID
      const early = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/releases/${rel.id}/release`, headers });
      expect(early.statusCode).toBe(409);
      expect(early.json().error.code).toBe("RELEASE_STATE_INVALID");

      // 审批
      const approved = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/releases/${rel.id}/approve`, headers, payload: { note: "仿真与校验全绿，准予发布" } });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().data.status).toBe("APPROVED");
      expect(approved.json().data.approved_by).toBeTruthy();
      expect(approved.json().data.approval_note).toBe("仿真与校验全绿，准予发布");

      // 二次审批 → 409
      const dup = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/releases/${rel.id}/approve`, headers });
      expect(dup.statusCode).toBe(409);

      // 发布
      const released = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/releases/${rel.id}/release`, headers });
      expect(released.statusCode).toBe(200);
      expect(released.json().data.status).toBe("RELEASED");
      expect(released.json().data.released_at).toBeTruthy();

      // 列表 + 详情
      const list = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/releases`, headers });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.length).toBe(1);
      const detail = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/releases/${rel.id}`, headers });
      expect(detail.json().data.status).toBe("RELEASED");

      // 再次创建 → version_no=2（版本链递增）
      const again = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/release`, headers });
      expect(again.statusCode).toBe(201);
      expect(again.json().data.version_no).toBe(2);
    });

    it("未知 Release → 404 RELEASE_NOT_FOUND；驳回需附理由", async () => {
      const { headers, partId } = await buildPartWithJob();
      const nf = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/releases/rel_nope`, headers });
      expect(nf.statusCode).toBe(404);
      expect(nf.json().error.code).toBe("RELEASE_NOT_FOUND");

      const created = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/release`, headers });
      const relId = created.json().data.id;
      const noNote = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/releases/${relId}/reject`, headers });
      expect(noNote.statusCode).toBe(422);

      const rejected = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/releases/${relId}/reject`, headers, payload: { note: "余量不足，需返工" } });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().data.status).toBe("REJECTED");
    });
  });

  describe("AI 规划（P4-9）：Preview → 审计 → Apply", () => {
    it("POST ai-plan：意图/Guardrails/工具选择 + ChangeSet（before=null）", async () => {
      const token = await login();
      const headers = { authorization: `Bearer ${token}` };
      const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
      const partId = created.json().data.part.id;
      await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/analyze`, headers });

      const res = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/ai-plan`, headers, payload: { goal: "表面光洁度优先" } });
      expect(res.statusCode).toBe(201);
      const data = res.json().data;
      expect(data.plan.id).toMatch(/^aiplan_/);
      expect(data.intent.strategy).toBe("finish_priority");
      expect(data.guardrail.ok).toBe(true);
      expect(data.setups.length).toBeGreaterThan(0);
      expect(data.process.order.length).toBeGreaterThan(0);
      expect(data.tool_choices.length).toBeGreaterThan(0);
      expect(data.tool_choices[0].reasons.length).toBeGreaterThan(0);
      expect(data.change_set.before).toBeNull();
      expect(data.change_set.after.operation_count).toBeGreaterThan(0);
      expect(data.change_set.reasons.length).toBeGreaterThan(0);
      expect(data.job.validated).toBe(true);
    });

    it("AI 规划审计列表 + Apply → 生成 CAM revision + Job", async () => {
      const token = await login();
      const headers = { authorization: `Bearer ${token}` };
      const created = await app.inject({ method: "POST", url: "/api/v1/parts", headers, payload: { filename: "box.step", content_type: "model/step", size_bytes: 1024 } });
      const partId = created.json().data.part.id;
      await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/analyze`, headers });

      const res = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/ai-plan`, headers, payload: { goal: "成本优先" } });
      const planId = res.json().data.plan.id;
      expect(res.json().data.intent.strategy).toBe("rough_then_finish");
      expect(res.json().data.intent.tool_weights.tool_cost).toBeGreaterThan(0.5);

      const list = await app.inject({ method: "GET", url: `/api/v1/parts/${partId}/ai-plans`, headers });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.length).toBe(1);
      expect(list.json().data[0].goal).toBe("成本优先");
      expect(list.json().data[0].tool_calls.length).toBeGreaterThan(0);

      const applied = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/ai-plans/${planId}/apply`, headers });
      expect(applied.statusCode).toBe(201);
      const d = applied.json().data;
      expect(d.revision_id).toMatch(/^cam_/);
      expect(d.revision_no).toBe(1);
      expect(d.job_run_id).toMatch(/^jobrun_/);

      // Apply 后 ChangeSet.before 不再为空（再次规划）
      const res2 = await app.inject({ method: "POST", url: `/api/v1/parts/${partId}/ai-plan`, headers, payload: { goal: "效率优先" } });
      expect(res2.json().data.change_set.before).not.toBeNull();
      expect(res2.json().data.change_set.before.cam_revision_id).toBe(d.revision_id);
    });
  });
});
