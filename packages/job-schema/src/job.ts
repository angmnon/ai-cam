/**
 * CAM Job 领域模型。
 * 状态集合对齐 PRD §47 与架构文档 §7；状态机见 state-machine.ts。
 */
import { z } from "zod";

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

// ---------- P2-02: zod schemas（唯一事实来源，job-runner 入口调用 parse 校验） ----------
export const StockPolicySchema = z.enum(["AUTO", "MANUAL"]);
export const ToolPolicyModeSchema = z.enum(["SPEED", "BALANCED", "TOOL_LIFE", "SURFACE_QUALITY", "MIN_TOOL_COUNT"]);
export const SurfacePrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const DimensionToleranceSchema = z.enum(["STANDARD", "TIGHT"]);
export const AxisModeSchema = z.enum(["3AXIS", "INDEXED_4AXIS"]);
export const FixtureModeSchema = z.enum(["AUTO", "MANUAL", "NONE"]);

export const JobInputSchema = z.object({
  part_id: z.string().min(1),
  machine_id: z.string().min(1),
  controller_id: z.string().min(1),
  material_id: z.string().min(1),
  stock_policy: StockPolicySchema.optional(),
  tool_policy: z
    .object({
      mode: ToolPolicyModeSchema.optional(),
      prefer_existing: z.boolean().optional(),
      max_tool_count: z.number().int().positive().optional(),
    })
    .optional(),
  quality: z
    .object({
      surface_priority: SurfacePrioritySchema.optional(),
      dimension_tolerance: DimensionToleranceSchema.optional(),
    })
    .optional(),
  axis_mode: AxisModeSchema.optional(),
  fixture_mode: FixtureModeSchema.optional(),
});
export type JobInput = z.infer<typeof JobInputSchema>;

/** Job 持久化记录（JobRecord）关键字段 zod schema */
export const JobRecordSchema = z.object({
  id: z.string().min(1),
  organization_id: z.string().min(1),
  project_id: z.string().optional(),
  part_revision_id: z.string().optional(),
  machine_id: z.string().min(1),
  controller_id: z.string().min(1),
  material_id: z.string().min(1),
  status: z.enum(JobStatuses),
  version: z.number().int().nonnegative(),
  planner_version: z.string().optional(),
  cam_engine_version: z.string().optional(),
  sim_version: z.string().optional(),
  post_version: z.string().optional(),
  created_by: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  input_hash: z.string().optional(),
  failure: z
    .object({
      code: z.string(),
      message: z.string(),
      stage: z.string().optional(),
      retryable: z.boolean(),
      occurred_at: z.string(),
    })
    .optional(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

/** @deprecated 兼容旧名；新代码请使用 JobRecord / JobRecordSchema */
export type Job = JobRecord;

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
