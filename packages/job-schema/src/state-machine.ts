/**
 * Job 状态机。
 * 原则（02_后端详细设计 §4）：Job 使用状态机，不允许 API 根据任意字符串跨状态跳转。
 * 失败进入 FAILED；可重试任务通过 retry 回到 DRAFT 重新走流水线。
 */
import { JobStatus, JobStatuses } from "./job.js";

/** 允许的迁移表（正向推进） */
export const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DRAFT: ["UPLOADING", "CANCELLED", "FAILED"],
  UPLOADING: ["PARSING", "FAILED", "CANCELLED"],
  PARSING: ["ANALYZING", "FAILED", "CANCELLED"],
  ANALYZING: ["PLANNING", "FAILED", "NEEDS_USER_INPUT", "CANCELLED"],
  PLANNING: ["GENERATING_TOOLPATH", "FAILED", "NEEDS_ENGINEER_REVIEW", "CANCELLED"],
  GENERATING_TOOLPATH: ["SIMULATING", "FAILED", "CANCELLED"],
  SIMULATING: ["VALIDATING", "FAILED", "GENERATING_TOOLPATH", "NEEDS_ENGINEER_REVIEW"],
  VALIDATING: ["READY_FOR_REVIEW", "FAILED", "GENERATING_TOOLPATH", "NEEDS_ENGINEER_REVIEW"],
  READY_FOR_REVIEW: ["APPROVED", "PLANNING", "FAILED", "BLOCKED"],
  APPROVED: ["RELEASED", "READY_FOR_REVIEW", "BLOCKED"],
  RELEASED: ["BLOCKED"],
  FAILED: ["DRAFT", "CANCELLED"],
  BLOCKED: ["READY_FOR_REVIEW", "CANCELLED"],
  CANCELLED: [],
  NEEDS_USER_INPUT: ["PLANNING", "CANCELLED", "FAILED"],
  NEEDS_ENGINEER_REVIEW: ["PLANNING", "READY_FOR_REVIEW", "CANCELLED", "FAILED"],
};

/** 终态 */
export const TERMINAL_STATUSES: readonly JobStatus[] = ["RELEASED", "CANCELLED"];

export class StateTransitionError extends Error {
  constructor(readonly from: JobStatus, readonly to: JobStatus) {
    super(`Illegal job state transition: ${from} -> ${to}`);
    this.name = "StateTransitionError";
  }
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new StateTransitionError(from, to);
  }
}

/** 状态机顶层入口：校验并返回新状态 */
export function transition(from: JobStatus, to: JobStatus): JobStatus {
  assertTransition(from, to);
  return to;
}

export { JobStatuses };
