/**
 * 结构化输出 Guardrails（P4-4）：LLM 输出的 Planner 意图必须通过 schema + enum/range/reference 校验。
 * 非法输出被拒绝并返回可解释错误（供 Agent 重试/转人工），不静默修正。
 */
import { z } from "zod";

export const PlannerStrategySchema = z.enum(["rough_then_finish", "finish_priority"]);
export const SetupPreferenceSchema = z.enum(["single_side_z", "two_side_z"]);
export const ProcessOrderSchema = z.enum(["FACE_FIRST", "DRILL_LAST", "DEFAULT"]);

export const PlannerOutputSchema = z.object({
  strategy: PlannerStrategySchema,
  setup_preference: SetupPreferenceSchema,
  process_order: ProcessOrderSchema,
  tool_weights: z
    .object({
      diameter_match: z.number().min(0).max(1),
      tool_cost: z.number().min(0).max(1),
      surface_quality: z.number().min(0).max(1),
    })
    .refine((w) => Math.abs(w.diameter_match + w.tool_cost + w.surface_quality - 1) < 1e-6, { message: "tool_weights 三项之和必须为 1" }),
  overrides: z
    .object({
      stepdown_mm: z.number().min(0.1).max(10).optional(),
      stepover_mm: z.number().min(0.1).max(10).optional(),
      finish_allowance_mm: z.number().min(0).max(1).optional(),
    })
    .optional(),
});

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export interface GuardrailViolation {
  path: string;
  message: string;
}

export interface GuardrailResult {
  ok: boolean;
  value: PlannerOutput | null;
  violations: GuardrailViolation[];
}

const toPath = (e: z.ZodError): GuardrailViolation[] =>
  e.issues.map((i) => ({ path: i.path.join(".") || "(root)", message: i.message }));

/** 解析 + schema 校验（不抛异常，返回可解释结果） */
export function validatePlannerOutput(raw: unknown): GuardrailResult {
  const parsed = PlannerOutputSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data, violations: [] };
  return { ok: false, value: null, violations: toPath(parsed.error) };
}

/** 引用校验：策略/顺序与程序化约束的一致性（reference/ACL 层） */
export function validatePlannerRefs(output: PlannerOutput, ctx: { featureCount: number; hasDrills: boolean }): GuardrailResult {
  const violations: GuardrailViolation[] = [];
  if (output.process_order === "DRILL_LAST" && !ctx.hasDrills) {
    violations.push({ path: "process_order", message: "DRILL_LAST 要求零件含钻孔特征，当前无 DRILL 特征" });
  }
  if (ctx.featureCount === 0) {
    violations.push({ path: "strategy", message: "零件无可用特征，无法规划" });
  }
  return { ok: violations.length === 0, value: output, violations };
}

/** 范围钳制参考（供 planner 层使用，AI 输出本身不静默修正） */
export const PARAM_LIMITS = {
  stepdown_mm: [0.1, 10] as const,
  stepover_mm: [0.1, 10] as const,
  finish_allowance_mm: [0, 1] as const,
};
