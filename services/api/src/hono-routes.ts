/**
 * Hono 路由注册（替代 Fastify 的 routes/*.ts）。
 * 业务语义与 Fastify 版逐行对齐；仅替换框架 API（c.get / c.req / c.json / c.body / SSE）。
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { ok, paged } from "./plugins/response.js";
import type { AppEnv, AuthUser } from "./hono-env.js";
import { buildSessionCookie, buildClearCookie } from "./hono-middlewares.js";
import { storageKey } from "./storage/storage.js";
import { planPart } from "@ai-cam/cam-kernel";
import { mustLatest } from "./cam/cam-store.js";
import { runJob, buildJobReport } from "@ai-cam/job-runner";
import { runCamAgent } from "@ai-cam/ai-planner";
import { checkPromptInjection, recordAudit } from "@ai-cam/security";
import { getMasterData } from "@ai-cam/master-data";
import { formatSse, sseComment, sseRetry, type CloudEvent, type EventType } from "@ai-cam/event-schema";
import { JobInput, JobStatus, JobStatuses } from "@ai-cam/job-schema";

type C = Context<AppEnv>;
function user(c: C): AuthUser {
  const u = c.get("user");
  if (!u) throw new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "No authenticated user.", stage: "api" });
  return u;
}

/* ===================================================================== *
 * Health
 * ===================================================================== */
function registerHealth(app: Hono<AppEnv>) {
  app.get("/health", (c) => c.json(ok({ service: "ai-cam-api", status: "ok", time: new Date().toISOString() })));
}

/* ===================================================================== *
 * Auth
 * ===================================================================== */
const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const ForgotBody = z.object({ email: z.string().email() });
const ResetBody = z.object({ token: z.string().min(1), new_password: z.string().min(8) });

function registerAuth(app: Hono<AppEnv>) {
  app.post("/api/v1/auth/login", async (c) => {
    const parsed = LoginBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid login payload.", stage: "auth", details: { issues: parsed.error.issues } });
    }
    const { email, password } = parsed.data;
    const outcome = await c.get("loginService").login(email, password);
    if (outcome.status === "locked") {
      c.header("retry-after", String(outcome.retryAfterSec));
      throw new ApiError({
        code: ErrorCodes.SYSTEM_RATE_LIMITED,
        message: "Account temporarily locked due to repeated failed logins. Try again later.",
        stage: "auth",
        retryable: true,
        details: { retry_after_sec: outcome.retryAfterSec },
      });
    }
    if (outcome.status === "invalid") {
      throw new ApiError({ code: ErrorCodes.AUTH_INVALID_CREDENTIALS, message: "Invalid email or password.", stage: "auth", retryable: false });
    }
    const identity = outcome.identity;
    const token = await c.get("auth").signToken(identity);
    const secure = c.get("config").nodeEnv === "production";
    c.header("set-cookie", buildSessionCookie(token, secure));
    return c.json(ok({ token, token_type: "Bearer", expires_in: "24h", user: identity }), 200);
  });

  app.post("/api/v1/auth/logout", (c) => {
    const secure = c.get("config").nodeEnv === "production";
    c.header("set-cookie", buildClearCookie(secure));
    return c.body(null, 204);
  });

  app.post("/api/v1/auth/forgot-password", async (c) => {
    const parsed = ForgotBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid forgot-password payload.", stage: "auth", details: { issues: parsed.error.issues } });
    }
    await c.get("loginService").forgotPassword(parsed.data.email);
    return c.json(ok({ message: "If the email exists, a reset token has been issued." }));
  });

  app.post("/api/v1/auth/reset-password", async (c) => {
    const parsed = ResetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid reset-password payload.", stage: "auth", details: { issues: parsed.error.issues } });
    }
    const ok2 = await c.get("loginService").resetPassword(parsed.data.token, parsed.data.new_password);
    if (!ok2) {
      throw new ApiError({ code: ErrorCodes.AUTH_INVALID_CREDENTIALS, message: "Reset token is invalid, expired, or already used.", stage: "auth", retryable: false });
    }
    return c.json(ok({ message: "Password updated successfully." }));
  });
}

/* ===================================================================== *
 * Files
 * ===================================================================== */
const CreateSessionBody = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1),
  size_bytes: z.number().int().positive(),
  resource_type: z.enum(["CAD_SOURCE", "CAD_PARSED", "VIEW_MESH", "SIMULATION_MESH", "TOOLPATH", "FIXTURE_CAD", "NC_PROGRAM", "SETUP_SHEET", "PROCESS_REPORT", "SIMULATION_REPORT"]),
  resource_id: z.string().min(1),
  version: z.string().default("v0"),
});

function registerFiles(app: Hono<AppEnv>) {
  app.post("/api/v1/files/upload-sessions", async (c) => {
    const parsed = CreateSessionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid upload session payload.", stage: "files", details: { issues: parsed.error.issues } });
    }
    const u = user(c);
    const session = await c.get("storage").createUploadSession(u.org_id, parsed.data.resource_type, parsed.data.resource_id, parsed.data.version, parsed.data.filename, parsed.data.content_type, parsed.data.size_bytes);
    return c.json(ok(session));
  });

  // 本地适配器上传端点（原始二进制；R2 模式不走此端点）
  app.post("/api/v1/files/upload", async (c) => {
    const u = user(c);
    const sessionId = c.req.header("x-session-id");
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    if (typeof sessionId !== "string") {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Missing x-session-id header.", stage: "files" });
    }
    const { key, sizeBytes } = await c.get("storage").consumeUploadSession(sessionId, u.org_id);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length === 0) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Empty or invalid upload body.", stage: "files" });
    }
    if (buf.length > sizeBytes) {
      throw new ApiError({
        code: ErrorCodes.FILE_TOO_LARGE,
        message: `Upload body ${buf.length} bytes exceeds declared session size ${sizeBytes} bytes.`,
        stage: "files",
        details: { declared_size_bytes: sizeBytes, actual_size_bytes: buf.length },
      });
    }
    const meta = await c.get("storage").put(key, buf, String(contentType), u.org_id);
    return c.json(ok(meta), 201);
  });
}

/* ===================================================================== *
 * Jobs
 * ===================================================================== */
const JobInputSchema = z.object({
  part_id: z.string().min(1),
  machine_id: z.string().min(1),
  controller_id: z.string().min(1),
  material_id: z.string().min(1),
  stock_policy: z.enum(["AUTO", "MANUAL"]).optional(),
  axis_mode: z.enum(["3AXIS", "INDEXED_4AXIS"]).optional(),
  fixture_mode: z.enum(["AUTO", "MANUAL", "NONE"]).optional(),
});
const CreateJobBody = z.object({ input: JobInputSchema });
const TransitionBody = z.object({ to: z.enum(JobStatuses), reason: z.string().max(500).optional() });
const FailBody = z.object({ code: z.string().min(1), message: z.string().min(1), stage: z.string().optional(), retryable: z.boolean().default(false) });

function registerJobs(app: Hono<AppEnv>) {
  app.post("/api/v1/jobs/", async (c) => {
    const parsed = CreateJobBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid job payload.", stage: "jobs", details: { issues: parsed.error.issues } });
    }
    const u = user(c);
    const idempotencyKey = c.req.header("idempotency-key") ?? undefined;
    const job = await c.get("jobs").create({ orgId: u.org_id, userId: u.sub, input: parsed.data.input as JobInput, idempotencyKey });
    return c.json(ok(job), 201);
  });

  app.get("/api/v1/jobs/", async (c) => {
    const u = user(c);
    const q = c.req.query();
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    const status = (q.status as JobStatus | undefined) ?? undefined;
    if (status && !JobStatuses.includes(status)) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: `Invalid status: ${status}`, stage: "jobs" });
    }
    const { items, total } = await c.get("jobs").list(u.org_id, { status, offset, limit });
    return c.json(paged(items, { offset, limit, total }));
  });

  app.get("/api/v1/jobs/:id", async (c) => {
    const u = user(c);
    return c.json(ok(await c.get("jobs").get(u.org_id, c.req.param("id"))));
  });

  app.post("/api/v1/jobs/:id/transition", async (c) => {
    const u = user(c);
    const parsed = TransitionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid transition payload.", stage: "jobs", details: { issues: parsed.error.issues } });
    }
    try {
      const job = await c.get("jobs").transitionTo(u.org_id, c.req.param("id"), parsed.data.to);
      return c.json(ok(job), 200);
    } catch (e) {
      if (e instanceof Error && e.name === "StateTransitionError") {
        throw new ApiError({ code: ErrorCodes.JOB_STATE_INVALID, message: e.message, stage: "jobs", retryable: false });
      }
      throw e;
    }
  });

  app.post("/api/v1/jobs/:id/fail", async (c) => {
    const u = user(c);
    const parsed = FailBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid failure payload.", stage: "jobs", details: { issues: parsed.error.issues } });
    }
    try {
      const job = await c.get("jobs").fail(u.org_id, c.req.param("id"), parsed.data);
      return c.json(ok(job));
    } catch (e) {
      if (e instanceof Error && e.name === "StateTransitionError") {
        throw new ApiError({ code: ErrorCodes.JOB_STATE_INVALID, message: e.message, stage: "jobs", retryable: false });
      }
      throw e;
    }
  });
}

/* ===================================================================== *
 * Master
 * ===================================================================== */
function registerMaster(app: Hono<AppEnv>) {
  app.get("/api/v1/master/machines", (c) => c.json(ok(getMasterData(user(c).org_id).machines)));
  app.get("/api/v1/master/controllers", (c) => c.json(ok(getMasterData(user(c).org_id).controllers)));
  app.get("/api/v1/master/tools", (c) => c.json(ok(getMasterData(user(c).org_id).tools)));
  app.get("/api/v1/master/materials", (c) => c.json(ok(getMasterData(user(c).org_id).materials)));
  app.get("/api/v1/master/cutting-rules", (c) => c.json(ok(getMasterData(user(c).org_id).cutting_rules)));
}

/* ===================================================================== *
 * Parts（含 CPU 信号量 + AI 规划 + Release 工作流）
 * ===================================================================== */
const CPU_MAX_CONCURRENCY = Math.max(1, Number(process.env.CPU_MAX_CONCURRENCY ?? 2) || 2);
let activeCpuJobs = 0;
const cpuQueue: Array<() => void> = [];
async function acquireCpuSlot(): Promise<void> {
  if (activeCpuJobs < CPU_MAX_CONCURRENCY) {
    activeCpuJobs++;
    return;
  }
  await new Promise<void>((resolve) => cpuQueue.push(resolve));
  activeCpuJobs++;
}
function releaseCpuSlot(): void {
  activeCpuJobs = Math.max(0, activeCpuJobs - 1);
  const next = cpuQueue.shift();
  if (next) next();
}

const PartFilename = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+\.(step|stp)$/i, "仅支持 .step/.stp，且文件名不得包含路径分隔符");
const CreatePartBody = z.object({ filename: PartFilename, content_type: z.string().min(1).default("model/step"), size_bytes: z.number().int().positive() });
const AiPlanBody = z.object({ goal: z.string().min(1).max(500).default("粗加工优先，兼顾表面质量"), dialect: z.enum(["FANUC", "SYNTEC", "MITSUBISHI", "ISO_GENERIC"]).optional() });
const ReleaseDecisionBody = z.object({ note: z.string().max(1000).optional(), profile: z.string().max(255).optional() });
const ReleaseRejectBody = z.object({ note: z.string().min(1).max(1000), profile: z.string().max(255).optional() });

function registerParts(app: Hono<AppEnv>, authorize: (action: import("@ai-cam/security").Action) => MiddlewareHandler<AppEnv>) {
  // create + CAD_SOURCE 上传会话
  app.post("/api/v1/parts/", async (c) => {
    const u = user(c);
    const parsed = CreatePartBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid part payload.", stage: "parts", details: { issues: parsed.error.issues } });
    }
    const part = await c.get("parts").create({ orgId: u.org_id, userId: u.sub, filename: parsed.data.filename, content_type: parsed.data.content_type, size_bytes: parsed.data.size_bytes, source_key: storageKey(u.org_id, "CAD_SOURCE", "", "v0", parsed.data.filename) });
    part.source_key = storageKey(u.org_id, "CAD_SOURCE", part.id, "v0", parsed.data.filename);
    const session = await c.get("storage").createUploadSession(u.org_id, "CAD_SOURCE", part.id, "v0", parsed.data.filename, parsed.data.content_type, parsed.data.size_bytes);
    return c.json(ok({ part, upload_session: session }), 201);
  });

  app.get("/api/v1/parts/", async (c) => {
    const u = user(c);
    const q = c.req.query();
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20));
    const { items, total } = await c.get("parts").list(u.org_id, { status: q.status as never, offset, limit });
    return c.json(paged(items, { offset, limit, total }));
  });

  app.get("/api/v1/parts/:id", async (c) => {
    const u = user(c);
    return c.json(ok(await c.get("parts").get(u.org_id, c.req.param("id"))));
  });

  app.post("/api/v1/parts/:id/analyze", async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const part = await c.get("parts").get(u.org_id, id);
    if (part.status !== "PENDING" && part.status !== "FAILED") {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: `Part status ${part.status} does not allow analyze.`, stage: "parts", retryable: false });
    }
    try {
      await acquireCpuSlot();
      const analysis = await c.get("partsAnalyzer").analyze({ orgId: u.org_id, partId: part.id, filename: part.filename, sourceKey: part.source_key, storage: c.get("storage") });
      const updated = await c.get("parts").setAnalysis(u.org_id, id, analysis);
      return c.json(ok(updated), 200);
    } catch (e) {
      if (e instanceof ApiError) {
        await c.get("parts").fail(u.org_id, id, { code: e.code, message: e.message, stage: e.stage ?? "parts" });
        throw e;
      }
      await c.get("parts").fail(u.org_id, id, { code: ErrorCodes.PART_ANALYSIS_FAILED, message: String((e as Error).message), stage: "parts" });
      throw e;
    } finally {
      releaseCpuSlot();
    }
  });

  app.get("/api/v1/parts/:id/features", async (c) => {
    const u = user(c);
    const part = await c.get("parts").get(u.org_id, c.req.param("id"));
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    return c.json(ok(part.analysis.features));
  });

  app.get("/api/v1/parts/:id/dfm", async (c) => {
    const u = user(c);
    const part = await c.get("parts").get(u.org_id, c.req.param("id"));
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    return c.json(ok(part.analysis.dfm));
  });

  app.post("/api/v1/parts/:id/toolpath", async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const part = await c.get("parts").get(u.org_id, id);
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    try {
      const { cam, toolpaths, parameterDecisions } = planPart(part.analysis.part, part.analysis.features.features);
      const revision = await c.get("cams").create({ orgId: u.org_id, partId: part.id, userId: u.sub, cam });
      return c.json(ok({ revision, cam, toolpaths, parameter_decisions: parameterDecisions }), 201);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError({ code: ErrorCodes.CAM_TOOLPATH_GENERATION_FAILED, message: String((e as Error).message), stage: "cam", retryable: true });
    }
  });

  app.get("/api/v1/parts/:id/toolpath", async (c) => {
    const u = user(c);
    const revision = await mustLatest(c.get("cams"), u.org_id, c.req.param("id"));
    return c.json(ok({ revision_id: revision.id, revision_no: revision.revision_no, engine_version: revision.engine_version, cam: revision.cam }));
  });

  app.post("/api/v1/parts/:id/job", authorize("job:run"), async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const part = await c.get("parts").get(u.org_id, id);
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    try {
      const job = runJob({ part: part.analysis.part, partName: id, features: part.analysis.features.features });
      if (!job.nc || !job.validation) {
        await c.get("jobRuns").createRun({ orgId: u.org_id, partId: id, userId: u.sub, run: { status: "FAIL", pipeline: job.pipeline, engine_version: job.cam.metadata?.generator_version ?? "0.1.0", validated: false } });
        throw new ApiError({ code: ErrorCodes.JOB_EXECUTION_FAILED, message: `NC 未生成（simulation=${job.simulation.status}）`, stage: "jobs", retryable: true });
      }
      if (!(await c.get("cams").latest(u.org_id, id))) await c.get("cams").create({ orgId: u.org_id, partId: id, userId: u.sub, cam: job.cam });
      const run = await c.get("jobRuns").createRun({ orgId: u.org_id, partId: id, userId: u.sub, run: { status: job.validation.status === "FAIL" ? "FAIL" : job.simulation.status === "FAIL" ? "FAIL" : job.validation.status, pipeline: job.pipeline, engine_version: job.cam.metadata?.generator_version ?? "0.1.0", validated: job.validated } });
      const ncRec = await c.get("jobRuns").createNc({ orgId: u.org_id, partId: id, jobRunId: run.id, nc: job.nc });
      const valRec = await c.get("jobRuns").createValidation({ orgId: u.org_id, partId: id, jobRunId: run.id, ncProgramId: ncRec.id, report: job.validation });
      await c.get("jobRuns").createSimulation({ orgId: u.org_id, partId: id, jobRunId: run.id, report: job.simulation });
      return c.json(ok({
        job: { id: run.id, status: run.status, validated: run.validated, pipeline: run.pipeline },
        nc: { program_number: ncRec.program_number, dialect: ncRec.dialect, line_count: ncRec.line_count, move_count: ncRec.move_count, tool_changes: ncRec.tool_changes },
        simulation: { status: job.simulation.status, removed_volume_mm3: job.simulation.removed_volume_mm3, residual_volume_mm3: job.simulation.residual_volume_mm3, events: job.simulation.events.length, frames: job.simulation.frames },
        validation: { id: valRec.id, status: valRec.status, layers: valRec.layers.map((l: { layer: string; status: string; checks: unknown[] }) => ({ layer: l.layer, status: l.status, checks: l.checks.length })) },
      }), 201);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError({ code: ErrorCodes.JOB_EXECUTION_FAILED, message: String((e as Error).message), stage: "jobs", retryable: true });
    }
  });

  app.get("/api/v1/parts/:id/job", async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const run = await c.get("jobRuns").latestRun(u.org_id, id);
    if (!run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "No job run for this part yet. POST /job first.", stage: "jobs", retryable: false });
    const bundle = await c.get("jobRuns").getBundle(u.org_id, id, run.id);
    return c.json(ok({
      run: { id: run.id, status: run.status, validated: run.validated, created_at: run.created_at, pipeline: run.pipeline },
      nc: bundle ? { program_number: bundle.nc.program_number, dialect: bundle.nc.dialect, line_count: bundle.nc.line_count } : null,
      validation: bundle ? { id: bundle.validation.id, status: bundle.validation.status, layers: bundle.validation.layers } : null,
    }));
  });

  app.get("/api/v1/parts/:id/job/nc", async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const run = await c.get("jobRuns").latestRun(u.org_id, id);
    if (!run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "No job run yet.", stage: "jobs", retryable: false });
    const nc = await c.get("jobRuns").getNc(u.org_id, id, run.id);
    return c.text(nc.nc_text, 200, { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${nc.program_number}.nc"` });
  });

  app.get("/api/v1/parts/:id/job/validation", async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const run = await c.get("jobRuns").latestRun(u.org_id, id);
    if (!run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "No job run yet.", stage: "jobs", retryable: false });
    const val = await c.get("jobRuns").getValidation(u.org_id, id, run.id);
    return c.json(ok(val.report));
  });

  app.get("/api/v1/parts/:id/job/report", async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const run = await c.get("jobRuns").latestRun(u.org_id, id);
    if (!run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "No job run yet.", stage: "jobs", retryable: false });
    const bundle = await c.get("jobRuns").getBundle(u.org_id, id, run.id);
    if (!bundle) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "Job bundle incomplete.", stage: "jobs", retryable: false });
    const camRev = await c.get("cams").latest(u.org_id, id);
    if (!camRev) throw new ApiError({ code: ErrorCodes.CAM_REVISION_NOT_FOUND, message: "CAM revision not found.", stage: "cam", retryable: false });
    const report = buildJobReport({
      cam: camRev.cam,
      simulation: bundle.simulation.report,
      nc: {
        program_number: bundle.nc.program_number, dialect: bundle.nc.dialect, post_version: bundle.nc.engine_version, controller_id: bundle.nc.controller_id,
        text: bundle.nc.nc_text, lines: bundle.nc.nc_text.split("\n"),
        metadata: { ir_id: camRev.cam.ir_id, job_id: camRev.cam.job_id, part_id: id, machine_id: camRev.cam.machine.machine_id, operation_count: camRev.cam.operations.length, tool_changes: bundle.nc.tool_changes, move_count: bundle.nc.move_count, generated_by: "post-core", generator_version: bundle.nc.engine_version, unsupported_move_count: 0, coolant_fallback_count: 0, tool_library_version: "unknown", material_version: "unknown", machine_firmware: "unknown" },
      },
      validation: bundle.validation.report,
    });
    return c.json(ok(report));
  });

  app.post("/api/v1/parts/:id/ai-plan", authorize("ai:plan"), async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const part = await c.get("parts").get(u.org_id, id);
    if (part.status !== "ANALYZED" || !part.analysis) throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    const parsed = AiPlanBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid ai-plan payload.", stage: "ai-plan", details: { issues: parsed.error.issues } });
    }
    const { goal, dialect } = parsed.data;
    const inject = checkPromptInjection(goal);
    if (inject.flagged) {
      await recordAudit(c.get("auditSink"), { actor: u.sub, role: u.roles[0] ?? "", action: "ai:plan", resource: id, detail: "prompt injection blocked" }, "DENIED");
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Prompt blocked by injection guardrail.", stage: "ai-plan", status: 400, details: { guardrail: true, findings: inject.findings } });
    }
    await acquireCpuSlot();
    try {
      const gateway = c.get("llmGateway");
      const run = await runCamAgent(part.analysis.part, part.analysis.features.features, { gateway, goal, dialect });
      const before = await c.get("cams").latest(u.org_id, id);
      const after = run.job.cam;
      const changeSet = {
        before: before ? { cam_revision_id: before.id, operation_count: before.cam.operations.length, tools: before.cam.tools.map((t: { tool_id: string }) => t.tool_id), setups: before.cam.setups.map((s2: { id: string }) => s2.id) } : null,
        after: { operation_count: after.operations.length, tools: after.tools.map((t) => t.tool_id), setups: after.setups.map((s2) => s2.id) },
        reasons: [
          ...run.guardrail.violations.map((v) => `Guardrail ${v.path}: ${v.message}`),
          ...run.tool_choices.slice(0, 4).map((t) => `${t.operation_type} → ${t.tool_id}（score ${t.score.toFixed(2)}）：${t.reasons[0] ?? ""}`),
          `路由：${run.model_route}（prompt v${run.prompt_version}）`,
        ],
      };
      const plan = await c.get("aiPlans").create({ organization_id: u.org_id, part_id: id, goal, intent: run.intent as Record<string, unknown>, guardrail: run.guardrail, model_route: run.model_route, prompt_version: run.prompt_version, change_set: changeSet, tool_calls: run.tool_calls.map((tc) => ({ tool: tc.tool, ok: tc.ok })), created_by: u.sub });
      return c.json(ok({
        plan: { id: plan.id, created_at: plan.created_at },
        intent: run.intent,
        guardrail: run.guardrail,
        setups: run.setups,
        process: run.process,
        tool_choices: run.tool_choices,
        change_set: changeSet,
        job: { validated: run.job.validated, simulation_status: run.job.simulation.status, validation_status: run.job.validation?.status ?? "FAIL" },
      }), 201, { "x-ai-mode": c.get("aiLlm") ? "live" : "mock" });
    } finally {
      releaseCpuSlot();
    }
  });

  app.get("/api/v1/parts/:id/ai-plans", async (c) => {
    const u = user(c);
    return c.json(ok(await c.get("aiPlans").list(u.org_id, c.req.param("id"))));
  });

  app.post("/api/v1/parts/:id/ai-plans/:planId/apply", authorize("ai:apply"), async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const planId = c.req.param("planId");
    const plan = await c.get("aiPlans").get(u.org_id, id, planId);
    const part = await c.get("parts").get(u.org_id, id);
    if (!part.analysis) throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    const gateway = c.get("llmGateway");
    const run = await runCamAgent(part.analysis.part, part.analysis.features.features, { gateway, goal: plan.goal, dialect: undefined });
    const revision = await c.get("cams").create({ orgId: u.org_id, partId: id, userId: u.sub, cam: run.job.cam });
    const jobRun = await c.get("jobRuns").createRun({ orgId: u.org_id, partId: id, userId: u.sub, run: { status: run.job.validation?.status === "FAIL" ? "FAIL" : (run.job.validation?.status ?? "FAIL"), pipeline: run.job.pipeline, engine_version: run.job.cam.metadata?.generator_version ?? "0.1.0", validated: run.job.validated } });
    return c.json(ok({ revision_id: revision.id, revision_no: revision.revision_no, job_run_id: jobRun.id, plan_id: plan.id }), 201);
  });

  app.post("/api/v1/parts/:id/release", authorize("release:request"), async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const part = await c.get("parts").get(u.org_id, id);
    if (part.status !== "ANALYZED" || !part.analysis) throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part not analyzed.", stage: "parts", retryable: false });
    const cam = await c.get("cams").latest(u.org_id, id);
    const run = await c.get("jobRuns").latestRun(u.org_id, id);
    if (!cam || !run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "Generate CAM + Job first (POST /toolpath, POST /job).", stage: "jobs", retryable: false });
    const rel = await c.get("releases").create({ orgId: u.org_id, partId: id, camRevisionId: cam.id, jobRunId: run.id, userId: u.sub });
    return c.json(ok(rel), 201);
  });

  app.get("/api/v1/parts/:id/releases", async (c) => {
    const u = user(c);
    return c.json(ok(await c.get("releases").list(u.org_id, c.req.param("id"))));
  });

  app.get("/api/v1/parts/:id/releases/:releaseId", async (c) => {
    const u = user(c);
    return c.json(ok(await c.get("releases").get(u.org_id, c.req.param("id"), c.req.param("releaseId"))));
  });

  app.post("/api/v1/parts/:id/releases/:releaseId/approve", authorize("release:approve"), async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const releaseId = c.req.param("releaseId");
    const parsed = ReleaseDecisionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid approve payload.", stage: "releases", details: { issues: parsed.error.issues } });
    }
    return c.json(ok(await c.get("releases").approve({ orgId: u.org_id, partId: id, releaseId, approverId: u.sub, note: parsed.data.note })));
  });

  app.post("/api/v1/parts/:id/releases/:releaseId/release", authorize("release:release"), async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const releaseId = c.req.param("releaseId");
    const parsed = ReleaseDecisionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid release payload.", stage: "releases", details: { issues: parsed.error.issues } });
    }
    return c.json(ok(await c.get("releases").release({ orgId: u.org_id, partId: id, releaseId, approverId: u.sub, note: parsed.data.note })));
  });

  app.post("/api/v1/parts/:id/releases/:releaseId/reject", authorize("release:approve"), async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const releaseId = c.req.param("releaseId");
    const parsed = ReleaseRejectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "note is required for reject.", stage: "releases", retryable: false, details: { issues: parsed.error.issues } });
    }
    return c.json(ok(await c.get("releases").reject({ orgId: u.org_id, partId: id, releaseId, approverId: u.sub, note: parsed.data.note })));
  });

  app.get("/api/v1/parts/:id/mesh", async (c) => {
    const u = user(c);
    const id = c.req.param("id");
    const part = await c.get("parts").get(u.org_id, id);
    if (!part.analysis?.mesh_key) {
      throw new ApiError({ code: ErrorCodes.PART_MESH_NOT_FOUND, message: "Mesh artifact not available for this part.", stage: "parts", retryable: false });
    }
    const { data } = await c.get("storage").get(part.analysis.mesh_key);
    return c.body(new Uint8Array(data), 200, { "content-type": "model/obj", "cache-control": "public, max-age=300" });
  });
}

/* ===================================================================== *
 * Events（SSE）
 * ===================================================================== */
const HEARTBEAT_MS = 15_000;

function registerEvents(app: Hono<AppEnv>) {
  app.get("/api/v1/events/stream", async (c) => {
    const u = user(c);
    const subject = (c.req.query("subject") as string | undefined) ?? null;
    const bus = c.get("bus");
    if (subject) {
      if (!subject.startsWith("job_")) {
        throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "subject must start with job_.", stage: "events" });
      }
      await c.get("jobs").get(u.org_id, subject);
    }
    const filter = subject
      ? undefined
      : (event: CloudEvent) => {
          if (!event.subject || !event.subject.startsWith("job_")) return false;
          return c.get("jobs").get(u.org_id, event.subject).then(() => true).catch(() => false);
        };

    const encoder = new TextEncoder();
    let unsub: () => void = () => undefined;
    let hb: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (s: string) => controller.enqueue(encoder.encode(s));
        send(sseComment("connected to ai-cam event stream"));
        send(sseRetry(3_000));
        send(formatSse({ specversion: "1.0", id: "evt_hello", source: "com.aicam.api", type: "hello" as EventType, subject: subject ?? "*", time: new Date().toISOString(), datacontenttype: "application/json" }));
        unsub = bus.subscribe(subject, (event) => {
          if (filter) {
            const verdict = filter(event);
            if (typeof verdict === "boolean") {
              if (!verdict) return;
              send(formatSse(event));
            } else {
              verdict.then((ok) => { if (ok) send(formatSse(event)); }).catch(() => undefined);
            }
          } else {
            send(formatSse(event));
          }
        });
        hb = setInterval(() => send(sseComment("heartbeat")), HEARTBEAT_MS);
      },
      cancel() {
        if (hb) clearInterval(hb);
        unsub();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}

/* ===================================================================== *
 * 入口
 * ===================================================================== */
export function registerRoutes(app: Hono<AppEnv>, authorize: (action: import("@ai-cam/security").Action) => MiddlewareHandler<AppEnv>): void {
  registerHealth(app);
  registerAuth(app);
  registerFiles(app);
  registerJobs(app);
  registerMaster(app);
  registerParts(app, authorize);
  registerEvents(app);
}
