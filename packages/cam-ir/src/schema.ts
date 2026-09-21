/**
 * CAM IR v1.0 Schema（zod 定义，唯一事实来源）。
 *
 * 设计约束（05_CAM_IR规范 / 系统架构设计 §12）：
 * - 单位统一 mm / deg / RPM / mm/min（字段带 _unit 后缀）
 * - 所有引用使用 ID 而非内联对象（tool_id / setup_id / feature_id）
 * - schema_version 固定 1.0.0；变更必须升级版本
 * - 可通过确定性序列化 + 哈希复现结果
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const CAM_IR_SCHEMA_VERSION = "1.0.0";

// ---------- 基础类型 ----------
export const Units = z.object({
  length: z.literal("mm"),
  angle: z.literal("deg"),
  speed: z.literal("rpm"),
  feed: z.literal("mm/min"),
});
export type Units = z.infer<typeof Units>;

export const Vec3 = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type Vec3 = z.infer<typeof Vec3>;

export const BBox = z.object({
  min: Vec3,
  max: Vec3,
});
export type BBox = z.infer<typeof BBox>;

// ---------- 库存 / 坐标 ----------
export const Stock = z.object({
  id: z.string(),
  kind: z.enum(["BOX", "CYLINDER", "FROM_SOLID", "CUSTOM"]),
  /** BOX: x/y/z 尺寸（mm）；CYLINDER: 直径+高；FROM_SOLID: 引用零件实体 */
  dimensions: z.record(z.string(), z.number()).optional(),
  origin: Vec3.optional(),
  margin: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional(),
});
export type Stock = z.infer<typeof Stock>;

export const MachineProfile = z.object({
  machine_id: z.string(),
  machine_name: z.string().optional(),
  controller_id: z.string(),
  controller_name: z.string().optional(),
  axis_config: z.enum(["3AXIS", "INDEXED_4AXIS"]),
  travel: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional(),
  max_spindle_rpm: z.number().optional(),
  max_feed: z.number().optional(),
});
export type MachineProfile = z.infer<typeof MachineProfile>;

export const MaterialProfile = z.object({
  material_id: z.string(),
  material_name: z.string().optional(),
  grade: z.string().optional(),
});
export type MaterialProfile = z.infer<typeof MaterialProfile>;

// ---------- 坐标/装夹 ----------
export const Setup = z.object({
  id: z.string(),
  name: z.string().optional(),
  wcs: z.enum(["G54", "G55", "G56", "G57", "G58", "G59"]).default("G54"),
  /** 装夹原点（工件坐标系原点在机床坐标下的位置） */
  origin: Vec3,
  /** Indexed 4 轴旋转（度）；3 轴为 0 */
  rotation: z.object({ axis: z.enum(["A", "B"]), angle: z.number() }).optional(),
  fixture_id: z.string().optional(),
  part_faces: z.array(z.string()).optional(),
});
export type Setup = z.infer<typeof Setup>;

// ---------- 刀具 ----------
export const ToolRef = z.object({
  tool_id: z.string(),
  tool_number: z.number().optional(),
  tool_assembly_id: z.string().optional(),
  /** 可选：优先级/评分（AI 排序结果，可解释） */
  rank: z.number().int().min(1).optional(),
  rank_reason: z.array(z.string()).optional(),
});
export type ToolRef = z.infer<typeof ToolRef>;

// ---------- 工序（Operation） ----------
export const OperationTypes = [
  "FACE",
  "ADAPTIVE_ROUGH",
  "POCKET",
  "REST_ROUGH",
  "CONTOUR",
  "SLOT",
  "DRILL",
  "SURFACE_PARALLEL",
  "SURFACE_WATERLINE",
  "CHAMFER",
  "ENGRAVE",
  "INDEX_ROTATE",
] as const;
export type OperationType = (typeof OperationTypes)[number];

export const CutDirection = z.enum(["CLIMB", "CONVENTIONAL", "BIDIRECTIONAL"]);
export type CutDirection = z.infer<typeof CutDirection>;

/** 切削参数（_unit 后缀：mm, mm/min, rpm, deg） */
export const CuttingParameters = z.object({
  spindle_speed_rpm: z.number().positive(),
  feed_mm_min: z.number().positive(),
  plunge_feed_mm_min: z.number().positive().optional(),
  stepdown_mm: z.number().positive().optional(),
  stepover_mm: z.number().positive().optional(),
  /** 进刀角度（度），0=垂直 */
  ramp_angle_deg: z.number().min(0).max(90).optional(),
  coolant: z.enum(["FLOOD", "MIST", "THROUGH", "OFF"]).default("FLOOD"),
  /** 参数来源：AI / ENGINE / USER / DEFAULT */
  source: z.enum(["AI", "ENGINE", "USER", "DEFAULT"]).default("ENGINE"),
});
export type CuttingParameters = z.infer<typeof CuttingParameters>;

export const Operation = z.object({
  id: z.string(),
  op_index: z.number().int().positive(),
  name: z.string().optional(),
  type: z.enum(OperationTypes),
  setup_id: z.string(),
  feature_ids: z.array(z.string()).min(1),
  tool: ToolRef,
  parameters: CuttingParameters,
  /** 加工顺序约束：本工序必须先于这些工序 */
  depends_on: z.array(z.string()).default([]),
  /** 退刀平面（绝对 Z，mm） */
  safe_z_mm: z.number().optional(),
  tolerance_mm: z.number().positive().optional(),
});
export type Operation = z.infer<typeof Operation>;

// ---------- Toolpath IR（确定性刀路结果） ----------
export const ToolpathMoveTypes = ["RAPID", "LINEAR", "ARC_CW", "ARC_CCW", "PLUNGE", "RETRACT"] as const;
export type ToolpathMoveType = (typeof ToolpathMoveTypes)[number];

export const ToolpathMove = z.object({
  type: z.enum(ToolpathMoveTypes),
  /** 目标点 */
  x: z.number(),
  y: z.number(),
  z: z.number(),
  /** 圆弧：圆心偏移 */
  i: z.number().optional(),
  j: z.number().optional(),
  k: z.number().optional(),
  feed_mm_min: z.number().optional(),
});
export type ToolpathMove = z.infer<typeof ToolpathMove>;

export const ToolpathIR = z.object({
  operation_id: z.string(),
  toolpath_id: z.string(),
  moves: z.array(ToolpathMove),
  /** 生成器版本（确定性复现关键） */
  engine_version: z.string(),
  bounds: BBox.optional(),
  move_count: z.number().int().nonnegative(),
});
export type ToolpathIR = z.infer<typeof ToolpathIR>;

// ---------- CAM IR 根对象 ----------
export const CamIR = z.object({
  schema_version: z.literal(CAM_IR_SCHEMA_VERSION),
  ir_id: z.string(),
  job_id: z.string(),
  part_id: z.string(),
  units: Units,
  machine: MachineProfile,
  material: MaterialProfile,
  stock: Stock,
  setups: z.array(Setup).min(1),
  tools: z.array(ToolRef).min(1),
  operations: z.array(Operation).min(1),
  toolpaths: z.array(ToolpathIR).optional(),
  metadata: z
    .object({
      generated_by: z.string(),
      generator_version: z.string(),
      created_at: z.string(),
      preferences: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type CamIR = z.infer<typeof CamIR>;

/**
 * 递归稳定序列化（deterministic stable stringify）：
 * - 普通对象：键按字典序递归排序（键序无关）
 * - 数组：保持原顺序
 * - 原始类型 / null：直接 JSON.stringify
 * - 对象值为 undefined 的键跳过（与 JSON.stringify 语义一致）
 *
 * 历史 bug（P1）：曾写成 JSON.stringify(ir, Object.keys(ir).sort())——第二参数是
 * 白名单 replacer 而非排序数组，导致所有嵌套对象被过滤成 {}，改嵌套字段 hash 不变。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/** 确定性规范化 JSON（字段顺序稳定，用于 hash 复现） */
export function canonicalJson<T>(ir: T): string {
  return stableStringify(ir);
}

/** 生成可复现指纹 */
export function camIrHash(ir: CamIR): string {
  return createHash("sha256").update(canonicalJson(ir)).digest("hex");
}
