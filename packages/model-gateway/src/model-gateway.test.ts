/** model-gateway 测试：路由 / MockProvider 确定性 / Prompt 模板（P4-1/P4-2） */
import { describe, expect, it } from "vitest";
import { ModelGateway } from "./gateway.js";
import { createMockProvider, MOCK_PROVIDER_SPEC } from "./mock.js";
import { buildPlannerPrompt, buildExplainPrompt, PROMPT_VERSION } from "./prompt.js";
import { estimateTokens } from "./provider.js";

describe("ModelGateway（P4-1）", () => {
  const gw = new ModelGateway({}).register(createMockProvider());

  it("任务标签路由：planner → mock provider", () => {
    const d = gw.decide("planner");
    expect(d.provider_id).toBe(MOCK_PROVIDER_SPEC.id);
    expect(d.reason).toContain("task-tag");
  });

  it("显式路由覆盖默认", () => {
    const gw2 = new ModelGateway({ routes: { planner: "mock_a" } }).register(createMockProvider({ ...MOCK_PROVIDER_SPEC, id: "mock_a" })).register(createMockProvider());
    const d = gw2.decide("planner");
    expect(d.provider_id).toBe("mock_a");
    expect(d.reason).toContain("explicit route");
  });

  it("无路由任务走 fallback", () => {
    const gw2 = new ModelGateway({ fallback: "mock_a" }).register(createMockProvider({ ...MOCK_PROVIDER_SPEC, id: "mock_a" }));
    expect(gw2.decide("unknown_task").provider_id).toBe("mock_a");
  });

  it("无任何 provider → 抛错", () => {
    expect(() => new ModelGateway({}).decide("planner")).toThrow(/no provider/);
  });

  it("complete 返回内容 + usage + 路由", async () => {
    const res = await gw.complete({ messages: [{ role: "user", content: "粗加工优先" }], task: "planner" });
    expect(res.route.provider_id).toBe(MOCK_PROVIDER_SPEC.id);
    expect(JSON.parse(res.content).strategy).toBe("rough_then_finish");
    expect(res.usage.total_tokens).toBeGreaterThan(0);
    expect(res.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("意图关键字 → 确定性策略（表面质量/成本）", async () => {
    const surface = await gw.complete({ messages: [{ role: "user", content: "我要表面光洁度优先" }], task: "planner" });
    expect(JSON.parse(surface.content).strategy).toBe("finish_priority");
    const cost = await gw.complete({ messages: [{ role: "user", content: "成本优先，便宜点" }], task: "planner" });
    expect(JSON.parse(cost.content).tool_weights.tool_cost).toBe(0.7);
  });
});

describe("Prompt 模板（P4-2）", () => {
  it("planner prompt 为压缩上下文（无 CAD 原始内容），带版本", () => {
    const p = buildPlannerPrompt({
      part: { id: "box", volume_mm3: 120000, bbox: { min: [0, 0, 0], max: [80, 50, 30] } },
      features: [{ id: "F1", type: "OUTER_PROFILE", dimensions: { w: 80, h: 50 }, accessible: ["+Z"] }],
      machine: { id: "mch_vmc850", name: "VMC850", axis: "3AXIS", max_rpm: 8000, max_feed: 12000 },
      tools: [{ id: "em_8", type: "FLAT_END_MILL", diameter_mm: 8, qty: 1 }],
      material: { id: "mat_al_6061", name: "Al6061", grade: "T6" },
      goal: "粗加工优先",
    });
    expect(p.version).toBe(PROMPT_VERSION);
    expect(p.messages[0].role).toBe("system");
    const user = p.messages[1].content;
    expect(user).toContain("零件：box");
    expect(user).toContain("特征（1）：F1[OUTER_PROFILE");
    expect(user).toContain("mch_vmc850");
    expect(user).toContain("用户目标：粗加工优先");
    expect(user).not.toContain("STL");
    expect(user).not.toContain("mesh");
  });

  it("explain prompt 生成可解释 JSON 指令", () => {
    const p = buildExplainPrompt({ strategy: "rough_then_finish" });
    expect(p.messages[0].content).toContain("JSON {explanation, risk, reason_ids}");
  });
});

describe("estimateTokens", () => {
  it("中英文混排确定性估算", () => {
    expect(estimateTokens("hello world 你好")).toBe(4);
  });
});
