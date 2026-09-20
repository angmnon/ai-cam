/**
 * CloudEvents 1.0 风格事件（架构文档 §15：事件统一 CloudEvents 风格，SSE 推送进度）。
 */

export const EventTypes = {
  // Job 生命周期
  JOB_CREATED: "job.created",
  JOB_PROGRESS: "job.progress",
  JOB_ANALYSIS_COMPLETED: "job.analysis.completed",
  JOB_TOOLPATH_COMPLETED: "job.toolpath.completed",
  JOB_SIMULATION_COMPLETED: "job.simulation.completed",
  JOB_VALIDATION_COMPLETED: "job.validation.completed",
  JOB_FAILED: "job.failed",
  JOB_RELEASED: "job.released",
  JOB_REPLAN: "job.replan",
  // 其余（后续阶段扩展）
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export interface CloudEvent<T = unknown> {
  specversion: "1.0";
  id: string;
  source: string; // 例如 "com.aicam.job-service"
  type: EventType | string;
  subject: string; // 例如 job_id
  time: string; // ISO8601
  datacontenttype: "application/json";
  data?: T;
  /** W3C traceparent，用于可观测性串联 */
  traceparent?: string;
}

export interface JobProgressData {
  status: string;
  progress: number; // 0..100
  stage?: string;
  message?: string;
  updated_at: string;
}

export interface JobFailedData {
  error: {
    code: string;
    message: string;
    stage?: string;
    retryable: boolean;
  };
  occurred_at: string;
}

export interface JobResultData {
  job_id: string;
  artifact_refs?: Array<{ type: string; key: string; size_bytes?: number }>;
  completed_at: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 构造标准 CloudEvent（补全 specversion/id/time 等字段） */
export function makeCloudEvent<T>(
  source: string,
  type: EventType | string,
  subject: string,
  data?: T,
  traceparent?: string,
): CloudEvent<T> {
  return {
    specversion: "1.0",
    id: newId("evt"),
    source,
    type,
    subject,
    time: nowIso(),
    datacontenttype: "application/json",
    data,
    traceparent,
  };
}
