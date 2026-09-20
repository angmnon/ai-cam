/**
 * Prompt / Context 模板（P4-2）：
 * 输入为 Feature Graph / Machine / Tool / Material / Rules / User 目标的**压缩摘要**，
 * 不塞入 CAD 原始网格/几何；模板带版本号（PROMPT_VERSION）可审计演进。
 */
import type { ChatMessage } from "./provider.js";

export const PROMPT_VERSION = "1.0.0";

export interface PlannerContext {
  part: { id: string; volume_mm3: number; bbox: { min: [number, number, number]; max: [number, number, number] } };
  features: Array<{ id: string; type: string; dimensions: Record<string, number>; accessible: string[] }>;
  machine: { id: string; name: string; axis: string; max_rpm: number; max_feed: number };
  tools: Array<{ id: string; type: string; diameter_mm: number; qty: number }>;
  material: { id: string; name: string; grade: string };
  rules_summary?: string[];
  goal: string;
  existing_plan?: { operation_count: number; tool_count: number; types: string[] };
}

/** 压缩上下文（确定性；Feature 维度取整到 2 位小数） */
export function buildPlannerContext(input: Omit<PlannerContext, "rules_summary"> & { rules_summary?: string[] }): PlannerContext {
  return {
    ...input,
    rules_summary: input.rules_summary ?? ["Material-OpType rule: Al6061 → FACE/POCKET vc≈150-300 m/min, DRILL vc≈60-80 m/min"],
  };
}

export interface PromptResult {
  version: string;
  messages: ChatMessage[];
}

const SYSTEM_PLANNER = `你是 CNC CAM 工艺规划助手。根据给定零件特征摘要与制造上下文，输出 JSON 规划意图（不要输出任何其他文字）。
JSON Schema:
{
  "strategy": "rough_then_finish" | "finish_priority",
  "setup_preference": "single_side_z" | "two_side_z",
  "process_order": "FACE_FIRST" | "DRILL_LAST",
  "tool_weights": { "diameter_match": number, "tool_cost": number, "surface_quality": number },  // 三者之和=1
  "overrides": { "stepdown_mm"?: number, "stepover_mm"?: number, "finish_allowance_mm"?: number }
}
约束：diameter_match/tool_cost/surface_quality 必须为 [0,1] 且和为 1；overrides 中 stepdown/stepover ∈ [0.1,10]，finish_allowance ∈ [0,1]。`;

export function buildPlannerPrompt(ctx: PlannerContext): PromptResult {
  const lines = [
    `零件：${ctx.part.id}，体积 ${ctx.part.volume_mm3.toFixed(0)} mm³，包络 ${ctx.part.bbox.min.join(",")}..${ctx.part.bbox.max.join(",")}`,
    `特征（${ctx.features.length}）：` + ctx.features.map((f) => `${f.id}[${f.type} ${Object.entries(f.dimensions).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(",")} 可达:${f.accessible.join("/")}]`).join(" | "),
    `机床：${ctx.machine.name}(${ctx.machine.id}) ${ctx.machine.axis} maxRPM=${ctx.machine.max_rpm} maxFeed=${ctx.machine.max_feed}`,
    `刀具（${ctx.tools.length}）：` + ctx.tools.map((t) => `${t.id}(${t.type} φ${t.diameter_mm} qty${t.qty})`).join(" | "),
    `材料：${ctx.material.name}(${ctx.material.id}) ${ctx.material.grade}`,
    `规则摘要：` + (ctx.rules_summary ?? []).join("；"),
    ctx.existing_plan ? `现有方案：${ctx.existing_plan.operation_count} 工序 / ${ctx.existing_plan.tool_count} 刀 / ${ctx.existing_plan.types.join(",")}` : "",
    `用户目标：${ctx.goal}`,
  ].filter(Boolean);

  return {
    version: PROMPT_VERSION,
    messages: [
      { role: "system", content: SYSTEM_PLANNER },
      { role: "user", content: lines.join("\n") },
    ],
  };
}

export function buildExplainPrompt(plan: Record<string, unknown>): PromptResult {
  return {
    version: PROMPT_VERSION,
    messages: [
      { role: "system", content: "你是 CNC CAM 工艺解释助手。用简短中文解释给定规划方案的动机与风险，输出 JSON {explanation, risk, reason_ids}。" },
      { role: "user", content: JSON.stringify(plan) },
    ],
  };
}
