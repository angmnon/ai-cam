/** 零件路由：创建（含上传会话）/ 分析 / 详情 / 特征 / DFM / 网格 / 刀路（CAM） */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { storageKey } from "../storage/storage.js";
import { ok, paged } from "../plugins/response.js";
import fp from "../plugins/fp.js";
import { planPart } from "@ai-cam/cam-kernel";
import { mustLatest } from "../cam/cam-store.js";
import { runJob } from "@ai-cam/job-runner";

const CreatePartBody = z.object({
  filename: z.string().min(1).max(255).regex(/\.(step|stp)$/i, "仅支持 .step/.stp"),
  content_type: z.string().min(1).default("model/step"),
  size_bytes: z.number().int().positive(),
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
  app.post("/:id/job", async (request, reply) => {
    const { id } = request.params as { id: string };
    const orgId = request.user!.org_id;
    const part = app.parts.get(orgId, id);
    if (part.status !== "ANALYZED" || !part.analysis) {
      throw new ApiError({ code: ErrorCodes.PART_STATE_INVALID, message: "Part has not been analyzed yet.", stage: "parts", retryable: false });
    }
    try {
      const job = runJob({ part: part.analysis.part, partName: id, features: part.analysis.features.features });
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
      return reply.status(201).send(
        ok({
          job: { id: run.id, status: run.status, validated: run.validated, pipeline: run.pipeline },
          nc: { program_number: ncRec.program_number, dialect: ncRec.dialect, line_count: ncRec.line_count, move_count: ncRec.move_count, tool_changes: ncRec.tool_changes },
          simulation: { status: job.simulation.status, removed_volume_mm3: job.simulation.removed_volume_mm3, residual_volume_mm3: job.simulation.residual_volume_mm3, events: job.simulation.events.length },
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
