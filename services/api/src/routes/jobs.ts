/** Job 路由（P0-6）：创建 / 列表 / 详情 / 状态迁移 / 失败上报 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { JobInput, JobStatus, JobStatuses } from "@ai-cam/job-schema";
import { paged, ok } from "../plugins/response.js";
import fp from "../plugins/fp.js";

const JobInputSchema = z.object({
  part_id: z.string().min(1),
  machine_id: z.string().min(1),
  controller_id: z.string().min(1),
  material_id: z.string().min(1),
  stock_policy: z.enum(["AUTO", "MANUAL"]).optional(),
  axis_mode: z.enum(["3AXIS", "INDEXED_4AXIS"]).optional(),
  fixture_mode: z.enum(["AUTO", "MANUAL", "NONE"]).optional(),
});

const CreateJobBody = z.object({
  input: JobInputSchema,
});

const TransitionBody = z.object({
  to: z.enum(JobStatuses),
  reason: z.string().max(500).optional(),
});

const FailBody = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  stage: z.string().optional(),
  retryable: z.boolean().default(false),
});

const jobRoutes: FastifyPluginAsync = async (app) => {
  // 创建 Job
  app.post(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["input"],
          properties: {
            input: {
              type: "object",
              required: ["part_id", "machine_id", "controller_id", "material_id"],
              properties: {
                part_id: { type: "string" },
                machine_id: { type: "string" },
                controller_id: { type: "string" },
                material_id: { type: "string" },
                stock_policy: { type: "string", enum: ["AUTO", "MANUAL"] },
                axis_mode: { type: "string", enum: ["3AXIS", "INDEXED_4AXIS"] },
                fixture_mode: { type: "string", enum: ["AUTO", "MANUAL", "NONE"] },
              },
            },
          },
        },
        tags: ["jobs"],
      },
    },
    async (request, reply) => {
      const body = CreateJobBody.safeParse(request.body);
      if (!body.success) {
        throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid job payload.", stage: "jobs", details: { issues: body.error.issues } });
      }
      const idempotencyKey = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined;
      const job = app.jobs.create({
        orgId: request.user!.org_id,
        userId: request.user!.sub,
        input: body.data.input as JobInput,
        idempotencyKey,
      });
      return reply.status(201).send(ok(job));
    },
  );

  // 列表（分页 + 状态过滤）
  app.get("/", async (request) => {
    const q = request.query as { page?: string; page_size?: string; status?: string };
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(q.page_size ?? 20)));
    const status = q.status as JobStatus | undefined;
    if (status && !JobStatuses.includes(status)) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: `Invalid status: ${status}`, stage: "jobs" });
    }
    const { items, total } = app.jobs.list(request.user!.org_id, { status, page, pageSize });
    return paged(items, { page, page_size: pageSize, total });
  });

  // 详情
  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    return ok(app.jobs.get(request.user!.org_id, id));
  });

  // 状态迁移（状态机门禁）
  app.post(
    "/:id/transition",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          required: ["to"],
          properties: {
            to: { type: "string", enum: [...JobStatuses] },
            reason: { type: "string" },
          },
        },
        tags: ["jobs"],
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = TransitionBody.safeParse(request.body);
      if (!body.success) {
        throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid transition payload.", stage: "jobs", details: { issues: body.error.issues } });
      }
      try {
        const job = app.jobs.transitionTo(request.user!.org_id, id, body.data.to);
        request.log.info({ job_id: id, to: body.data.to, reason: body.data.reason }, "job transitioned");
        return reply.status(200).send(ok(job));
      } catch (e) {
        if (e instanceof Error && e.name === "StateTransitionError") {
          throw new ApiError({
            code: ErrorCodes.JOB_STATE_INVALID,
            message: e.message,
            stage: "jobs",
            retryable: false,
          });
        }
        throw e;
      }
    },
  );

  // 失败上报（进入 FAILED 并发布 JOB_FAILED）
  app.post("/:id/fail", async (request) => {
    const { id } = request.params as { id: string };
    const body = FailBody.safeParse(request.body);
    if (!body.success) {
      throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid failure payload.", stage: "jobs", details: { issues: body.error.issues } });
    }
    try {
      const job = app.jobs.fail(request.user!.org_id, id, body.data);
      return ok(job);
    } catch (e) {
      if (e instanceof Error && e.name === "StateTransitionError") {
        throw new ApiError({
          code: ErrorCodes.JOB_STATE_INVALID,
          message: e.message,
          stage: "jobs",
          retryable: false,
        });
      }
      throw e;
    }
  });
};

export default fp(jobRoutes);
