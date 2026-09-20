/** DFM 报告契约（面向制造的可行性检查结果） */
import { z } from "zod";

export const DfmSeverity = z.enum(["INFO", "WARNING", "BLOCKER"]);
export type DfmSeverity = z.infer<typeof DfmSeverity>;

export const DfmItem = z.object({
  id: z.string(),
  severity: DfmSeverity,
  /** 规则编码，如 DFM-0102 */
  code: z.string(),
  message: z.string(),
  /** 关联特征 id（可空 = 面向零件整体） */
  feature_ids: z.array(z.string()).default([]),
  /** 数值证据 */
  details: z.record(z.string(), z.number()).optional(),
});
export type DfmItem = z.infer<typeof DfmItem>;

export const DfmReport = z.object({
  part_id: z.string(),
  rules_version: z.string(),
  created_at: z.string(),
  summary: z.object({
    info: z.number(),
    warning: z.number(),
    blocker: z.number(),
  }),
  items: z.array(DfmItem),
});
export type DfmReport = z.infer<typeof DfmReport>;
