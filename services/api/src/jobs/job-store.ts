/**
 * Job 存储与流转（P0-6）。Phase 0 为进程内实现；
 * 接入 PostgreSQL 时保持同接口（job 表 + job_events 表）。
 */
import { randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { EventTypes } from "@ai-cam/event-schema";
import { Job, JobInput, JobStatus, jobInputHash, transition } from "@ai-cam/job-schema";
import type { EventBus } from "../bus/event-bus.js";

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

export interface JobStore {
  create(input: { orgId: string; userId: string; input: JobInput; idempotencyKey?: string }): Promise<Job>;
  get(orgId: string, jobId: string): Promise<Job>;
  list(orgId: string, opts: { status?: JobStatus; offset: number; limit: number }): Promise<{ items: Job[]; total: number }>;
  transitionTo(orgId: string, jobId: string, to: JobStatus): Promise<Job>;
  fail(orgId: string, jobId: string, failure: { code: string; message: string; stage?: string; retryable: boolean }): Promise<Job>;
}

const EVENT_SOURCE = "com.aicam.job-service";

export function createJobStore(bus: EventBus): JobStore {
  const jobs = new Map<string, Job>();

  function mustGet(orgId: string, jobId: string): Job {
    const job = jobs.get(jobId);
    if (!job) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: `Job not found: ${jobId}`, stage: "jobs" });
    if (job.organization_id !== orgId) {
      throw new ApiError({ code: ErrorCodes.AUTH_FORBIDDEN, message: "Job does not belong to this organization.", stage: "jobs" });
    }
    return job;
  }

  function save(job: Job): Job {
    jobs.set(job.id, job);
    return job;
  }

  function emitProgress(job: Job): void {
    bus.publishFor(EVENT_SOURCE, EventTypes.JOB_PROGRESS, job.id, {
      status: job.status,
      progress: PROGRESS_BY_STATUS[job.status] ?? 0,
      stage: job.status.toLowerCase(),
      updated_at: job.updated_at,
    });
  }

  return {
    async create({ orgId, userId, input, idempotencyKey }) {
      const inputHash = jobInputHash(input);
      if (idempotencyKey) {
        for (const job of jobs.values()) {
          if (job.organization_id === orgId && job.input_hash === inputHash) {
            // 同组织同输入：幂等返回已有 Job（Idempotency-Key 一致才视为同一次请求）
            throw new ApiError({
              code: ErrorCodes.JOB_IDEMPOTENCY_CONFLICT,
              message: `Job already exists for this input (job=${job.id}). Provide Idempotency-Key or use existing job.`,
              stage: "jobs",
              retryable: false,
            });
          }
        }
      }
      const now = new Date().toISOString();
      const job: Job = {
        id: `job_${randomUUID().replaceAll("-", "")}`,
        organization_id: orgId,
        machine_id: input.machine_id,
        controller_id: input.controller_id,
        material_id: input.material_id,
        status: "DRAFT",
        version: 0,
        input_hash: inputHash,
        created_by: userId,
        created_at: now,
        updated_at: now,
      };
      save(job);
      bus.publishFor(EVENT_SOURCE, EventTypes.JOB_CREATED, job.id, { job_id: job.id });
      return job;
    },

    async get(orgId, jobId) {
      return mustGet(orgId, jobId);
    },

    async list(orgId, { status, offset, limit }) {
      const all = [...jobs.values()].filter((j) => j.organization_id === orgId && (!status || j.status === status));
      all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      // P2-52：内存分页，语义对齐 SQL OFFSET ? LIMIT ?（offset 跳过、limit 截断）
      return { items: all.slice(offset, offset + limit), total: all.length };
    },

    async transitionTo(orgId, jobId, to) {
      const job = mustGet(orgId, jobId);
      transition(job.status, to); // 非法跳转抛 StateTransitionError → 由路由转 ApiError
      job.status = to;
      job.version += 1;
      job.updated_at = new Date().toISOString();
      save(job);
      emitProgress(job);
      if (to === "RELEASED") {
        bus.publishFor(EVENT_SOURCE, EventTypes.JOB_RELEASED, job.id, { job_id: job.id, completed_at: job.updated_at });
      }
      return job;
    },

    async fail(orgId, jobId, failure) {
      const job = mustGet(orgId, jobId);
      transition(job.status, "FAILED");
      job.status = "FAILED";
      job.version += 1;
      job.updated_at = new Date().toISOString();
      job.failure = { ...failure, occurred_at: job.updated_at };
      save(job);
      bus.publishFor(EVENT_SOURCE, EventTypes.JOB_FAILED, job.id, {
        error: { code: failure.code, message: failure.message, stage: failure.stage, retryable: failure.retryable },
        occurred_at: job.updated_at,
      });
      return job;
    },
  };
}
