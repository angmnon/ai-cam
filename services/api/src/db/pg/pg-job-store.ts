/**
 * P0-01：jobs 域 PostgreSQL 实现（表：cam_jobs，迁移 0001）。
 * P1-07：经 withOrgScope 绑定 app.org_id，RLS 强制多租户隔离。
 * - 状态机跳转复用 @ai-cam/job-schema 的 transition()；进度/失败事件仍经 EventBus 发布。
 */
import { randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { EventTypes } from "@ai-cam/event-schema";
import { type Job, type JobStatus, jobInputHash, transition } from "@ai-cam/job-schema";
import type { EventBus } from "../../bus/event-bus.js";
import type { JobStore } from "../../jobs/job-store.js";
import { withOrgScope, type SqlDb } from "../org-scope.js";

const PROGRESS_BY_STATUS: Record<string, number> = {
  DRAFT: 5,
  UPLOADING: 10,
  PARSING: 20,
  ANALYZING: 35,
  PLANNING: 45,
  GENERATING_TOOLPATH: 60,
  SIMULATING: 80,
  VALIDATING: 90,
  READY_FOR_REVIEW: 95,
  APPROVED: 98,
  RELEASED: 100,
};

const EVENT_SOURCE = "com.aicam.job-service";

interface JobRow {
  id: string;
  organization_id: string;
  machine_id: string;
  controller_id: string;
  material_id: string;
  status: string;
  version: string | number;
  input_hash: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  failure: unknown;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    organization_id: row.organization_id,
    machine_id: row.machine_id,
    controller_id: row.controller_id,
    material_id: row.material_id,
    status: row.status as JobStatus,
    version: Number(row.version),
    input_hash: row.input_hash ?? "",
    created_by: row.created_by ?? "",
    created_at: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
    updated_at: (row.updated_at as Date)?.toISOString?.() ?? String(row.updated_at),
    ...(row.failure ? { failure: row.failure as Job["failure"] } : {}),
  };
}

export function createPgJobStore(db: SqlDb, bus: EventBus): JobStore {
  return {
    async create({ orgId, userId, input, idempotencyKey }): Promise<Job> {
      const inputHash = jobInputHash(input);
      return withOrgScope(db, orgId, async (client) => {
        if (idempotencyKey) {
          const dup = await client.query<JobRow>(
            `SELECT * FROM cam_jobs WHERE organization_id = $1 AND input_hash = $2`,
            [orgId, inputHash],
          );
          if (dup.rows[0]) {
            throw new ApiError({
              code: ErrorCodes.JOB_IDEMPOTENCY_CONFLICT,
              message: `Job already exists for this input (job=${dup.rows[0].id}). Provide Idempotency-Key or use existing job.`,
              stage: "jobs",
              retryable: false,
            });
          }
        }
        const id = `job_${randomUUID().replaceAll("-", "")}`;
        const { rows } = await client.query<JobRow>(
          `INSERT INTO cam_jobs (id, organization_id, machine_id, controller_id, material_id, status, version, input_hash, created_by)
           VALUES ($1,$2,$3,$4,$5,'DRAFT',0,$6,$7)
           RETURNING *`,
          [id, orgId, input.machine_id, input.controller_id, input.material_id, inputHash, userId],
        );
        const job = rowToJob(rows[0]);
        return job;
      }).then((job) => {
        bus.publishFor(EVENT_SOURCE, EventTypes.JOB_CREATED, job.id, { job_id: job.id });
        return job;
      });
    },

    async get(orgId: string, jobId: string): Promise<Job> {
      return withOrgScope(db, orgId, async (client) => {
        const { rows } = await client.query<JobRow>(`SELECT * FROM cam_jobs WHERE id = $1 AND organization_id = $2`, [jobId, orgId]);
        if (!rows[0]) {
          throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: `Job not found: ${jobId}`, stage: "jobs" });
        }
        return rowToJob(rows[0]);
      });
    },

    async list(orgId: string, opts: { status?: JobStatus; offset: number; limit: number }) {
      return withOrgScope(db, orgId, async (client) => {
        const where: string[] = ["organization_id = $1"];
        const params: unknown[] = [orgId];
        if (opts.status) {
          params.push(opts.status);
          where.push(`status = $${params.length}`);
        }
        params.push(opts.offset, opts.limit);
        const offsetIdx = params.length - 1;
        const limitIdx = params.length - 2;
        const { rows } = await client.query<JobRow>(
          `SELECT * FROM cam_jobs
           WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT $${offsetIdx} OFFSET $${limitIdx}`,
          params,
        );
        const countParams = [orgId, ...(opts.status ? [opts.status] : [])];
        const countWhere = ["organization_id = $1", ...(opts.status ? [`status = $2`] : [])];
        const cnt = await client.query<{ n: string }>(`SELECT count(*)::int AS n FROM cam_jobs WHERE ${countWhere.join(" AND ")}`, countParams);
        return { items: rows.map(rowToJob), total: Number(cnt.rows[0]?.n ?? 0) };
      });
    },

    async transitionTo(orgId: string, jobId: string, to: JobStatus): Promise<Job> {
      const job = await this.get(orgId, jobId);
      transition(job.status, to); // 非法跳转抛 StateTransitionError → 由路由转 ApiError
      const updated = await withOrgScope(db, orgId, async (client) => {
        const { rows } = await client.query<JobRow>(
          `UPDATE cam_jobs SET status = $1, version = version + 1, updated_at = now()
           WHERE id = $2 AND organization_id = $3 RETURNING *`,
          [to, jobId, orgId],
        );
        return rowToJob(rows[0]);
      });
      bus.publishFor(EVENT_SOURCE, EventTypes.JOB_PROGRESS, updated.id, {
        status: updated.status,
        progress: PROGRESS_BY_STATUS[updated.status] ?? 0,
        stage: updated.status.toLowerCase(),
        updated_at: updated.updated_at,
      });
      if (to === "RELEASED") {
        bus.publishFor(EVENT_SOURCE, EventTypes.JOB_RELEASED, updated.id, { job_id: updated.id, completed_at: updated.updated_at });
      }
      return updated;
    },

    async fail(orgId: string, jobId: string, failure: { code: string; message: string; stage?: string; retryable: boolean }): Promise<Job> {
      const job = await this.get(orgId, jobId);
      transition(job.status, "FAILED");
      const updated = await withOrgScope(db, orgId, async (client) => {
        const { rows } = await client.query<JobRow>(
          `UPDATE cam_jobs SET status = 'FAILED', version = version + 1, updated_at = now(), failure = $1
           WHERE id = $2 AND organization_id = $3 RETURNING *`,
          [JSON.stringify({ ...failure, occurred_at: new Date().toISOString() }), jobId, orgId],
        );
        return rowToJob(rows[0]);
      });
      bus.publishFor(EVENT_SOURCE, EventTypes.JOB_FAILED, updated.id, {
        error: { code: failure.code, message: failure.message, stage: failure.stage, retryable: failure.retryable },
        occurred_at: updated.updated_at,
      });
      return updated;
    },
  };
}
