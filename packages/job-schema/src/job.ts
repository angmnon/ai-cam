/**
 * CAM Job 领域模型。
 * 状态集合对齐 PRD §47 与架构文档 §7；状态机见 state-machine.ts。
 */

export const JobStatuses = [
  "DRAFT",
  "UPLOADING",
  "PARSING",
  "ANALYZING",
  "PLANNING",
  "GENERATING_TOOLPATH",
  "SIMULATING",
  "VALIDATING",
  "READY_FOR_REVIEW",
  "APPROVED",
  "RELEASED",
  // 异常/终态
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "NEEDS_USER_INPUT",
  "NEEDS_ENGINEER_REVIEW",
] as const;

export type JobStatus = (typeof JobStatuses)[number];

export interface JobInput {
  part_id: string;
  machine_id: string;
  controller_id: string;
  material_id: string;
  stock_policy?: "AUTO" | "MANUAL";
  tool_policy?: {
    mode?: "SPEED" | "BALANCED" | "TOOL_LIFE" | "SURFACE_QUALITY" | "MIN_TOOL_COUNT";
    prefer_existing?: boolean;
    max_tool_count?: number;
  };
  quality?: {
    surface_priority?: "LOW" | "MEDIUM" | "HIGH";
    dimension_tolerance?: "STANDARD" | "TIGHT";
  };
  axis_mode?: "3AXIS" | "INDEXED_4AXIS";
  fixture_mode?: "AUTO" | "MANUAL" | "NONE";
}

export interface Job {
  id: string;
  organization_id: string;
  project_id?: string;
  part_revision_id?: string;
  machine_id: string;
  controller_id: string;
  material_id: string;
  status: JobStatus;
  /** 乐观锁版本号（02_后端详细设计 §10） */
  version: number;
  planner_version?: string;
  cam_engine_version?: string;
  sim_version?: string;
  post_version?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** 幂等键：job_id + input_hash */
  input_hash?: string;
  failure?: {
    code: string;
    message: string;
    stage?: string;
    retryable: boolean;
    occurred_at: string;
  };
}

/** Job 输入指纹，用于幂等与结果可复现 */
export function jobInputHash(input: JobInput): string {
  // 稳定序列化：字段固定顺序
  const canonical = JSON.stringify({
    part_id: input.part_id,
    machine_id: input.machine_id,
    controller_id: input.controller_id,
    material_id: input.material_id,
    stock_policy: input.stock_policy ?? "AUTO",
    tool_policy: input.tool_policy ?? {},
    quality: input.quality ?? {},
    axis_mode: input.axis_mode ?? "3AXIS",
    fixture_mode: input.fixture_mode ?? "AUTO",
  });
  return canonical;
}
