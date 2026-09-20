/**
 * MockProvider（确定性）：无真实 API key 的本地/CI 回退。
 * 按 user 消息中声明的意图关键字返回预置内容，保证测试可复现。
 */
import { estimateTokens, type CompletionRequest, type CompletionResult, type ModelProvider, type ModelSpec } from "./provider.js";

export const MOCK_PROVIDER_SPEC: ModelSpec = {
  id: "mock_planner_v1",
  vendor: "mock",
  model: "mock-planner-1",
  tasks: ["planner", "param", "explain", "assistant"],
  cost_weight: 0,
  latency_ms: 2,
};

/** 意图 → 预置 planner JSON（供 MockProvider 返回） */
export const MOCK_PLANS: Record<string, Record<string, unknown>> = {
  rough_first: {
    strategy: "rough_then_finish",
    setup_preference: "single_side_z",
    process_order: "FACE_FIRST",
    tool_weights: { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 },
    overrides: { stepdown_mm: 2.0, stepover_mm: 0.5 },
  },
  surface_quality: {
    strategy: "finish_priority",
    setup_preference: "single_side_z",
    process_order: "FACE_FIRST",
    tool_weights: { diameter_match: 0.3, tool_cost: 0.1, surface_quality: 0.6 },
    overrides: { finish_allowance_mm: 0.02 },
  },
  cost_first: {
    strategy: "rough_then_finish",
    setup_preference: "single_side_z",
    process_order: "FACE_FIRST",
    tool_weights: { diameter_match: 0.2, tool_cost: 0.7, surface_quality: 0.1 },
    overrides: { stepover_mm: 0.7 },
  },
};

export function createMockProvider(spec: ModelSpec = MOCK_PROVIDER_SPEC): ModelProvider {
  return {
    spec,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const userText = req.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      let content: string;
      if (req.task === "explain") {
        content = JSON.stringify({ explanation: "（Mock）该方案优先保证粗加工效率，粗切后精修 0.05mm 余量。", risk: "无已知碰撞风险。", reason_ids: ["R_rough_first"] });
      } else {
        const plan = /粗|效率|快/.test(userText)
          ? MOCK_PLANS.rough_first
          : /表面|光洁|质量/.test(userText)
            ? MOCK_PLANS.surface_quality
            : /成本|便宜|低价/.test(userText)
              ? MOCK_PLANS.cost_first
              : MOCK_PLANS.rough_first;
        content = JSON.stringify(plan);
      }
      const tokens = estimateTokens(req.messages.map((m) => m.content).join("\n"));
      return {
        content,
        model_id: spec.id,
        usage: { prompt_tokens: tokens, completion_tokens: estimateTokens(content), total_tokens: tokens + estimateTokens(content) },
        latency_ms: spec.latency_ms ?? 2,
      };
    },
  };
}
