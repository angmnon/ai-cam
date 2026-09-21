/** 零件路由：创建（含上传会话）/ 分析 / 详情 / 特征 / DFM / 网格 / 刀路（CAM） */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { storageKey } from "../storage/storage.js";
import { ok, paged } from "../plugins/response.js";
import fp from "../plugins/fp.js";
import { planPart } from "@ai-cam/cam-kernel";
import { mustLatest } from "../cam/cam-store.js";
import { runJob, buildJobReport } from "@ai-cam/job-runner";
import { runCamAgent } from "@ai-cam/ai-planner";
import { ModelGateway } from "@ai-cam/model-gateway";
import { createMockProvider } from "@ai-cam/model-gateway";
// P0-4：RBAC 授权 + Prompt 注入扫描 + 审计
import { checkPromptInjection, recordAudit } from "@ai-cam/security";

/**
 * P2-45：CPU 密集 handler 并发信号量。
 * 原因：POST /:id/analyze（几何解析）与 POST /:id/ai-plan（CAM 规划 runCamAgent）
 * 在 Node 事件循环上执行同步 CPU 密集计算，并发过高会阻塞事件循环、拖垮其它请求。
 * 模块级 Promise 队列限制在事件循环上同时占用 CPU 的任务数；默认 maxConcurrent=2，
 * 可用 env CPU_MAX_CONCURRENCY 覆盖。超限的 handler 排队等待（测试串行，不阻塞现有用例）。
 */
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

// P1-21：文件名只允许安全字符 + .step/.stp，拒绝 ../ 等路径穿越
const PartFilename = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+\.(step|stp)$/i, "仅支持 .step/.stp，且文件名不得包含路径分隔符");

const CreatePartBody = z.object({
  filename: PartFilename,
  content_type: z.string().min(1).default("model/step"),
  size_bytes: z.number().int().positive(),
});

// P1-20：AI 规划 body —— goal 文本 + 控制器方言枚举
const AiPlanBody = z.object({
  goal: z.string().min(1).max(500).default("粗加工优先，兼顾表面质量"),
  dialect: z.enum(["FANUC", "SYNTEC", "MITSUBISHI", "ISO_GENERIC"]).optional(),
});

// P1-20：Release 审批/放行 body
const ReleaseDecisionBody = z.object({
  note: z.string().max(1000).optional(),
  profile: z.string().max(255).optional(),
});

// P1-20：Release 驳回 body —— note 必填
const ReleaseRejectBody = z.object({
  note: z.string().min(1).max(1000),
  profile: z.string().max(255).optional(),
});

const partRoutes: FastifyPluginAsync = async (app) => {
  // 创建零件 + CAD_SOURCE 上传会话
  app.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["filename", "size_bytes"],
          properties: {
            filename: { type: "string" },
            content_type: { type: "string" },
            size_bytes: { type: "integer" },
          },
        },
        tags: ["parts"],
      },
    },
    async (request, reply) => {
      const body = CreatePartBody.safeParse(request.body);
      if (!body.success) {
        throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid part payload.", stage: "parts", details: { issues: body.error.issues } });
      }
      const orgId = request.user!.org_id;
      const part = app.parts.create({
        orgId,
        userId: request.user!.sub,
        filename: body.data.filename,
        content_type: body.data.content_type,
        size_bytes: body.data.size_bytes,
        source_key: storageKey(orgId, "CAD_SOURCE", "", "v0", body.data.filename),
      });
      // 用 part.id 重建 source_key（CAD_SOURCE 资源 id = part id）
      part.source_key = storageKey(orgId, "CAD_SOURCE", part.id, "v0", body.data.filename);

      const session = await app.storage.createUploadSession(
        orgId,
        "CAD_SOURCE",
        part.id,
        "v0",
        body.data.filename,
        body.data.content_type,
        body.data.size_bytes,
      );
      return reply.status(201).send(ok({ part, upload_session: session }));
    },
  );

  // 列表
  app.get("/", async (request) => {
    const q = request.query as { page?: string; page_size?: string; status?: string };
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.page_size ?? 20)));
    const { items, total } = app.parts.list(request.user!.org_id, { status: q.status as never, page, pageSize });
    return paged(items, { page, page_size: pageSize, total });
  });

  // 详情（含分析摘要）
  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    return ok(app.parts.get(request.user!.org_id, id));
  });

  // 触发分析（PARSING → ANALYZED / FAILED）
  app.post(
    "/:id/analyze",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        tags: ["parts"],
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const orgId = request.user!.org_id;
      const part = app.parts.get(orgId, id);
      if (part.status !== "PENDING" && part.status !== "FAILED") {
        throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: `Part status ${part.status} does not allow analyze.`, stage: "parts", retryable: false });
      }
      try {
        // P2-45：几何解析为 CPU 密集同步计算，经模块级信号量限流
        await acquireCpuSlot();
        const analysis = await app.partsAnalyzer.analyze({
          orgId,
          partId: part.id,
          filename: part.filename,
          sourceKey: part.source_key,
          storage: app.storage,
        });
        const updated = app.parts.setAnalysis(orgId, id, analysis);
        return reply.status(200).send(ok(updated));
      } catch (e) {
        if (e instanceof ApiError) {
          app.parts.fail(orgId, id, { code: e.code, message: e.message, stage: e.stage ?? "parts" });
          throw e;
        }
        app.parts.fail(orgId, id, { code: ErrorCodes.PART_ANALYSIS_FAILED, message: String((e as Error).message), stage: "parts" });
        throw e;
      } finally {
        releaseCpuSlot();
      }
    },
  );

  // 特征图
  app.get("/:id/features", async (request) => {
    const { id } = request.params as { id: string };
    const part = app.parts.get(request.user!.org_id, id);
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    return ok(part.analysis.features);
  });

  // DFM 报告
  app.get("/:id/dfm", async (request) => {
    const { id } = request.params as { id: string };
    const part = app.parts.get(request.user!.org_id, id);
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    return ok(part.analysis.dfm);
  });

  // 生成/更新 CAM 工艺计划（Phase 2：cam-kernel 确定性规划）
  app.post("/:id/toolpath", async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const part = app.parts.get(orgId, id);
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    try {
      const { cam, toolpaths, parameterDecisions } = planPart(part.analysis.part, part.analysis.features.features);
      const revision = app.cams.create({ orgId, partId: part.id, userId: request.user!.sub, cam });
      return reply.status(201).send(ok({ revision, cam, toolpaths, parameter_decisions: parameterDecisions }));
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError({ code: ErrorCodes.CAM_TOOLPATH_GENERATION_FAILED, message: String((e as Error).message), stage: "cam", retryable: true });
    }
  });

  // 最新 CAM 工艺计划
  app.get("/:id/toolpath", async (request) => {
    const { id } = request.params as { id: string };
    const revision = mustLatest(app.cams, request.user!.org_id, id);
    return ok({ revision_id: revision.id, revision_no: revision.revision_no, engine_version: revision.engine_version, cam: revision.cam });
  });

  // 一键 Job：plan → sim → post → validate → Validated NC（P3-8）
  // P0-4：需 job:run 权限
  app.post("/:id/job", { preHandler: app.authorize("job:run") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const part = app.parts.get(orgId, id);
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    try {
      const job = runJob({ part: part.analysis.part, partName: id, features: part.analysis.features.features });
      if (!app.cams.latest(orgId, id)) app.cams.create({ orgId, partId: id, userId: request.user!.sub, cam: job.cam });
      const run = app.jobRuns.createRun({
        orgId,
        partId: id,
        userId: request.user!.sub,
        run: {
          status: job.validation.status === "FAIL" ? "FAIL" : job.simulation.status === "FAIL" ? "FAIL" : job.validation.status,
          pipeline: job.pipeline,
          engine_version: job.cam.metadata?.generator_version ?? "0.1.0",
          validated: job.validated,
        },
      });
      const ncRec = app.jobRuns.createNc({ orgId, partId: id, jobRunId: run.id, nc: job.nc });
      const valRec = app.jobRuns.createValidation({ orgId, partId: id, jobRunId: run.id, ncProgramId: ncRec.id, report: job.validation });
      app.jobRuns.createSimulation({ orgId, partId: id, jobRunId: run.id, report: job.simulation });
      return reply.status(201).send(
        ok({
          job: { id: run.id, status: run.status, validated: run.validated, pipeline: run.pipeline },
          nc: { program_number: ncRec.program_number, dialect: ncRec.dialect, line_count: ncRec.line_count, move_count: ncRec.move_count, tool_changes: ncRec.tool_changes },
          simulation: { status: job.simulation.status, removed_volume_mm3: job.simulation.removed_volume_mm3, residual_volume_mm3: job.simulation.residual_volume_mm3, events: job.simulation.events.length, frames: job.simulation.frames },
          validation: { id: valRec.id, status: valRec.status, layers: valRec.layers.map((l) => ({ layer: l.layer, status: l.status, checks: l.checks.length })) },
        }),
      );
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError({ code: ErrorCodes.JOB_EXECUTION_FAILED, message: String((e as Error).message), stage: "jobs", retryable: true });
    }
  });

  // 最近一次 Job 运行
  app.get("/:id/job", async (request) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const run = app.jobRuns.latestRun(orgId, id);
    if (!run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "No job run for this part yet. POST /job first.", stage: "jobs", retryable: false });
    const bundle = app.jobRuns.getBundle(orgId, id, run.id);
    return ok({
      run: { id: run.id, status: run.status, validated: run.validated, created_at: run.created_at, pipeline: run.pipeline },
      nc: bundle ? { program_number: bundle.nc.program_number, dialect: bundle.nc.dialect, line_count: bundle.nc.line_count } : null,
      validation: bundle ? { id: bundle.validation.id, status: bundle.validation.status, layers: bundle.validation.layers } : null,
    });
  });

  // NC 程序文本
  app.get("/:id/job/nc", async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const run = app.jobRuns.latestRun(orgId, id);
    if (!run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "No job run yet.", stage: "jobs", retryable: false });
    const nc = app.jobRuns.getNc(orgId, id, run.id);
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${nc.program_number}.nc"`)
      .send(nc.nc_text);
  });

  // 校验报告
  app.get("/:id/job/validation", async (request) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const run = app.jobRuns.latestRun(orgId, id);
    if (!run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "No job run yet.", stage: "jobs", retryable: false });
    const val = app.jobRuns.getValidation(orgId, id, run.id);
    return ok(val.report);
  });

  // Job 报告（P3-9：工艺单/刀具清单/Setup Sheet/仿真摘要）
  app.get("/:id/job/report", async (request) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const run = app.jobRuns.latestRun(orgId, id);
    if (!run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "No job run yet.", stage: "jobs", retryable: false });
    const bundle = app.jobRuns.getBundle(orgId, id, run.id);
    if (!bundle) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "Job bundle incomplete.", stage: "jobs", retryable: false });
    const camRev = app.cams.latest(orgId, id);
    if (!camRev) throw new ApiError({ code: ErrorCodes.CAM_REVISION_NOT_FOUND, message: "CAM revision not found.", stage: "cam", retryable: false });
    const report = buildJobReport({
      cam: camRev.cam,
      simulation: bundle.simulation.report,
      nc: {
        program_number: bundle.nc.program_number,
        dialect: bundle.nc.dialect,
        post_version: bundle.nc.engine_version,
        controller_id: bundle.nc.controller_id,
        text: bundle.nc.nc_text,
        lines: bundle.nc.nc_text.split("\n"),
        metadata: { ir_id: camRev.cam.ir_id, job_id: camRev.cam.job_id, part_id: id, machine_id: camRev.cam.machine.machine_id, operation_count: camRev.cam.operations.length, tool_changes: bundle.nc.tool_changes, move_count: bundle.nc.move_count, generated_by: "post-core", generator_version: bundle.nc.engine_version },
      },
      validation: bundle.validation.report,
    });
    return ok(report);
  });

  // AI 规划（P4-9）：Preview → 审计 → 审计 → Apply
  // P0-4：需 ai:plan 权限；调 ModelGateway 前先对 goal 做 Prompt 注入扫描。
  app.post("/:id/ai-plan", { preHandler: app.authorize("ai:plan") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const part = app.parts.get(orgId, id);
    if (part.status !== "ANALYZED" || !part.analysis) throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    const parsed = AiPlanBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid ai-plan payload.", stage: "ai-plan", details: { issues: parsed.error.issues } });
    }
    const { goal, dialect } = parsed.data;
    // Prompt 注入防护：非 LOW 命中直接拒绝，不落 ModelGateway
    const inject = checkPromptInjection(goal);
    if (inject.flagged) {
      await recordAudit(app.auditSink, { actor: request.user!.sub, role: request.user!.roles[0] ?? "", action: "ai:plan", resource: id, detail: "prompt injection blocked" }, "DENIED");
      throw new ApiError({
        code: ErrorCodes.SYSTEM_VALIDATION,
        message: "Prompt blocked by injection guardrail.",
        stage: "ai-plan",
        status: 400,
        details: { guardrail: true, findings: inject.findings },
      });
    }
    // P2-45：CAM 规划（runCamAgent）为 CPU 密集同步计算，经模块级信号量限流（注入拦截等轻量前置校验不占槽）
    await acquireCpuSlot();
    try {
      const gateway = new ModelGateway({}).register(createMockProvider());
      const run = await runCamAgent(part.analysis.part, part.analysis.features.features, {
        gateway,
        goal,
        dialect,
      });
    const before = app.cams.latest(orgId, id);
    const after = run.job.cam;
    const changeSet = {
      before: before ? { cam_revision_id: before.id, operation_count: before.cam.operations.length, tools: before.cam.tools.map((t) => t.tool_id), setups: before.cam.setups.map((s2) => s2.id) } : null,
      after: { operation_count: after.operations.length, tools: after.tools.map((t) => t.tool_id), setups: after.setups.map((s2) => s2.id) },
      reasons: [
        ...run.guardrail.violations.map((v) => `Guardrail ${v.path}: ${v.message}`),
        ...run.tool_choices.slice(0, 4).map((t) => `${t.operation_type} → ${t.tool_id}（score ${t.score.toFixed(2)}）：${t.reasons[0] ?? ""}`),
        `路由：${run.model_route}（prompt v${run.prompt_version}）`,
      ],
    };
    const plan = app.aiPlans.create({
      organization_id: orgId,
      part_id: id,
      goal,
      intent: run.intent as Record<string, unknown>,
      guardrail: run.guardrail,
      model_route: run.model_route,
      prompt_version: run.prompt_version,
      change_set: changeSet,
      tool_calls: run.tool_calls.map((tc) => ({ tool: tc.tool, ok: tc.ok })),
      created_by: request.user!.sub,
    });
    // P1-17：标注本次规划由真实 LLM 还是 MockProvider 执行
    return reply
      .header("x-ai-mode", app.aiLlm ? "live" : "mock")
      .status(201)
      .send(
        ok({
          plan: { id: plan.id, created_at: plan.created_at },
        intent: run.intent,
        guardrail: run.guardrail,
        setups: run.setups,
        process: run.process,
        tool_choices: run.tool_choices,
        change_set: changeSet,
        job: { validated: run.job.validated, simulation_status: run.job.simulation.status, validation_status: run.job.validation.status },
      }),
    );
    } finally {
      releaseCpuSlot();
    }
  });

  app.get("/:id/ai-plans", async (request) => {
    const { id } = request.params as { id: string };
    return ok(app.aiPlans.list(request.user!.org_id, id));
  });

  // P0-4：应用 AI 规划需 ai:apply 权限
  app.post("/:id/ai-plans/:planId/apply", { preHandler: app.authorize("ai:apply") }, async (request, reply) => {
    const { id, planId } = request.params as { id: string; planId: string };
    const orgId = request.user!.org_id;
    const plan = app.aiPlans.get(orgId, id, planId);
    const part = app.parts.get(orgId, id);
    if (!part.analysis) throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    const gateway = new ModelGateway({}).register(createMockProvider());
    const run = await runCamAgent(part.analysis.part, part.analysis.features.features, { gateway, goal: plan.goal, dialect: undefined });
    const revision = app.cams.create({ orgId, partId: id, userId: request.user!.sub, cam: run.job.cam });
    const jobRun = app.jobRuns.createRun({
      orgId,
      partId: id,
      userId: request.user!.sub,
      run: {
        status: run.job.validation.status === "FAIL" ? "FAIL" : run.job.validation.status,
        pipeline: run.job.pipeline,
        engine_version: run.job.cam.metadata?.generator_version ?? "0.1.0",
        validated: run.job.validated,
      },
    });
    return reply.status(201).send(ok({ revision_id: revision.id, revision_no: revision.revision_no, job_run_id: jobRun.id, plan_id: plan.id }));
  });

  // Release 工作流（P4-11）
  // P0-4：创建发布请求需 release:request 权限
  app.post("/:id/release", { preHandler: app.authorize("release:request") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const part = app.parts.get(orgId, id);
    if (part.status !== "ANALYZED" || !part.analysis) throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part not analyzed.", stage: "parts", retryable: false });
    const cam = app.cams.latest(orgId, id);
    const run = app.jobRuns.latestRun(orgId, id);
    if (!cam || !run) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "Generate CAM + Job first (POST /toolpath, POST /job).", stage: "jobs", retryable: false });
    const rel = app.releases.create({ orgId, partId: id, camRevisionId: cam.id, jobRunId: run.id, userId: request.user!.sub });
    return reply.status(201).send(ok(rel));
  });

  app.get("/:id/releases", async (request) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    return ok(app.releases.list(orgId, id));
  });

  app.get("/:id/releases/:releaseId", async (request) => {
    const { id, releaseId } = request.params as { id: string; releaseId: string };
    const orgId = request.user!.org_id;
    return ok(app.releases.get(orgId, id, releaseId));
  });

  // P0-4：审批需 release:approve 权限（RBAC 职责分离）
  app.post("/:id/releases/:releaseId/approve", { preHandler: app.authorize("release:approve") }, async (request) => {
    const { id, releaseId } = request.params as { id: string; releaseId: string };
    const parsed = ReleaseDecisionBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid approve payload.", stage: "releases", details: { issues: parsed.error.issues } });
    }
    return ok(app.releases.approve({ orgId: request.user!.org_id, partId: id, releaseId, approverId: request.user!.sub, note: parsed.data.note }));
  });

  // P0-4：正式放行需 release:release 权限
  app.post("/:id/releases/:releaseId/release", { preHandler: app.authorize("release:release") }, async (request) => {
    const { id, releaseId } = request.params as { id: string; releaseId: string };
    const parsed = ReleaseDecisionBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid release payload.", stage: "releases", details: { issues: parsed.error.issues } });
    }
    return ok(app.releases.release({ orgId: request.user!.org_id, partId: id, releaseId, approverId: request.user!.sub, note: parsed.data.note }));
  });

  // P0-4：驳回属发布治理决策；矩阵无 release:reject，复用最接近的 release:approve 动作。
  app.post("/:id/releases/:releaseId/reject", { preHandler: app.authorize("release:approve") }, async (request) => {
    const { id, releaseId } = request.params as { id: string; releaseId: string };
    const parsed = ReleaseRejectBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "note is required for reject.", stage: "releases", retryable: false, details: { issues: parsed.error.issues } });
    }
    return ok(app.releases.reject({ orgId: request.user!.org_id, partId: id, releaseId, approverId: request.user!.sub, note: parsed.data.note }));
  });

  // 网格（OBJ）
  app.get("/:id/mesh", async (request, reply) => {
    const { id } = request.params as { id: string };
    const part = app.parts.get(request.user!.org_id, id);
    if (!part.analysis?.mesh_key) {
      throw new ApiError({ code: ErrorCodes.PART_MESH_NOT_FOUND, message: "Mesh artifact not available for this part.", stage: "parts", retryable: false });
    }
    const { data } = await app.storage.get(part.analysis.mesh_key);
    return reply
      .header("content-type", "model/obj")
      .header("cache-control", "public, max-age=300")
      .send(data);
  });
};

export default fp(partRoutes);
