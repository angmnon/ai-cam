/**
 * 刀具与刀柄组装主数据（12_数据规范 / 架构 §27-§28）。
 * Tool 与 Tool Assembly 分离：Assembly = Holder + Adapter + 伸出量。
 */
import { z } from "zod";

export const ToolType = z.enum([
  "FLAT_END_MILL",
  "BALL_END_MILL",
  "BULL_NOSE",
  "DRILL",
  "CHAMFER",
  "TAPER_END_MILL",
  "ENGRAVING",
  "DEBURR",
  "THREAD_MILL",
]);
export type ToolType = z.infer<typeof ToolType>;

export const ToolFlute = z.enum(["2F", "3F", "4F", "5F", "6F", "SINGLE"]);
export type ToolFlute = z.infer<typeof ToolFlute>;

export const ToolCoating = z.enum(["NONE", "TIN", "TIALN", "ALCRN", "DLC", "UNCOATED_CARBIDE"]);
export type ToolCoating = z.infer<typeof ToolCoating>;

export const Tool = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  type: ToolType,
  /** 刀具材料：HSS / CARBIDE / CARBIDE_COATED / PCD / ... */
  tool_material: z.string(),
  /** 直径（mm） */
  diameter_mm: z.number().positive(),
  /** 刃长（mm） */
  flute_length_mm: z.number().positive(),
  /** 总长（mm） */
  overall_length_mm: z.number().positive(),
  /** 圆角/刀尖半径（mm，平刀 0） */
  corner_radius_mm: z.number().nonnegative().default(0),
  /** 排屑槽数 */
  flute_count: z.number().int().positive().default(4),
  flute: ToolFlute.optional(),
  coating: ToolCoating.default("NONE"),
  /** 库存数量 */
  stock_qty: z.number().int().nonnegative().default(0),
  /** 所在刀库位置（可选） */
  pocket: z.number().int().optional(),
  version: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Tool = z.infer<typeof Tool>;

/** 刀柄/夹头类型 */
export const HolderType = z.enum([
  "BT30",
  "BT40",
  "BT50",
  "HSK63",
  "HSK100",
  "ER16",
  "ER20",
  "ER32",
  "COLLET",
  "SHRINK_FIT",
  "HYDRAULIC",
]);
export type HolderType = z.infer<typeof HolderType>;

export const ToolAssembly = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  holder: z.object({ type: HolderType, gauge_length_mm: z.number().positive() }),
  /** 刀尖到夹持端总伸出量（mm）——碰撞检测关键参数 */
  reach_mm: z.number().positive(),
  tool_id: z.string(),
  /** 是否已测长/已标定 */
  calibrated: z.boolean().default(false),
  version: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ToolAssembly = z.infer<typeof ToolAssembly>;
