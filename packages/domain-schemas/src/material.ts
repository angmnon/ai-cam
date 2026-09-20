/**
 * 材料与切削规则主数据（08_刀具材料切削参数引擎 / 架构 §29）。
 * 规则优先级：企业规则 > 材料规则 > 刀具约束 > AI 优化。
 */
import { z } from "zod";

export const MaterialCategory = z.enum([
  "ALUMINUM",
  "STEEL",
  "STAINLESS",
  "BRASS",
  "COPPER",
  "PLASTIC",
  "TITANIUM",
]);
export type MaterialCategory = z.infer<typeof MaterialCategory>;

export const CoolantStrategy = z.enum(["FLOOD", "MIST", "THROUGH", "OFF", "DRY"]);
export type CoolantStrategy = z.infer<typeof CoolantStrategy>;

export const Material = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  category: MaterialCategory,
  grade: z.string().optional(), // 6061-T6 / 304 / POM-C ...
  /** 硬度（HRC 或 HB 注明） */
  hardness: z.string().optional(),
  density_kg_m3: z.number().positive().optional(),
  default_coolant: CoolantStrategy.default("FLOOD"),
  /** 是否可铣削（禁止项拦截） */
  machinable: z.boolean().default(true),
  version: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Material = z.infer<typeof Material>;

/** 一条切削规则：给定刀具类型+材料，给出参数区间与推荐值 */
export const CuttingRule = z.object({
  id: z.string(),
  material_id: z.string(),
  tool_type: z.string(),
  /** 切削线速度区间（m/min） */
  vc_range_m_min: z.object({ min: z.number(), max: z.number() }),
  /** 每齿进给区间（mm/tooth） */
  fz_range_mm: z.object({ min: z.number(), max: z.number() }),
  /** 推荐轴向切深系数（×刀具直径） */
  doc_ratio_recommended: z.object({ min: z.number(), max: z.number() }),
  /** 推荐径向切宽系数（×刀具直径） */
  woc_ratio_recommended: z.object({ min: z.number(), max: z.number() }),
  /** 规则来源：MANUFACTURER / EXPERT / FACTORY / STANDARD */
  source: z.enum(["MANUFACTURER", "EXPERT", "FACTORY", "STANDARD"]),
  effective_from: z.string(),
  effective_to: z.string().optional(),
  version: z.number().int().nonnegative().default(0),
  created_at: z.string(),
});
export type CuttingRule = z.infer<typeof CuttingRule>;
