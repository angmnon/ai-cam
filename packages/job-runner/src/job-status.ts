/**
 * P2-30 Job 状态机：PENDING → PLANNED → SIMULATED → POSTED → VALIDATED → RELEASED / FAILED
 *
 * - 合法迁移表（Map）：JOB_STATUS_TRANSITIONS，key=当前状态，value=允许迁移到的目标状态集合。
 * - transitionJobStatus(from, to)：推进状态；不在迁移表中则抛 IllegalJobStatusTransitionError。
 * - createJobStatusMachine()：返回一个持有当前状态的句柄，供编排器（runJob）链式推进。
 * - RELEASED / FAILED 为终态，无出边。
 */

export type JobStatus =
  | "PENDING"
  | "PLANNED"
  | "SIMULATED"
  | "POSTED"
  | "VALIDATED"
  | "RELEASED"
  | "FAILED";

/** 合法迁移表：当前状态 → 允许迁移到的目标状态集合 */
export const JOB_STATUS_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  PENDING: ["PLANNED", "FAILED"],
  PLANNED: ["SIMULATED", "FAILED"],
  SIMULATED: ["POSTED", "FAILED"],
  POSTED: ["VALIDATED", "FAILED"],
  VALIDATED: ["RELEASED", "FAILED"],
  RELEASED: [],
  FAILED: [],
};

/** 非法状态迁移错误 */
export class IllegalJobStatusTransitionError extends Error {
  override name = "IllegalJobStatusTransitionError";
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    const allowed = JOB_STATUS_TRANSITIONS[from];
    super(
      allowed.length > 0
        ? `非法 Job 状态迁移：${from} → ${to}（允许迁移到：${allowed.join(", ")}）`
        : `非法 Job 状态迁移：${from} → ${to}（${from} 为终态，无出边）`,
    );
  }
}

/**
 * 推进 Job 状态。若 from→to 不在合法迁移表中，抛 IllegalJobStatusTransitionError。
 * 成功时返回目标状态 to。
 */
export function transitionJobStatus(from: JobStatus, to: JobStatus): JobStatus {
  const allowed = JOB_STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new IllegalJobStatusTransitionError(from, to);
  }
  return to;
}

/**
 * 新建一个处于 PENDING 初始态的 Job 状态机句柄。
 * current 只读；advance(to) 校验并推进，非法迁移抛错。
 */
export function createJobStatusMachine(): {
  readonly current: JobStatus;
  advance: (to: JobStatus) => JobStatus;
} {
  let value: JobStatus = "PENDING";
  return {
    get current(): JobStatus {
      return value;
    },
    advance(to: JobStatus): JobStatus {
      value = transitionJobStatus(value, to);
      return value;
    },
  };
}
