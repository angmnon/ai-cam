/** 企业规则引擎测试（P5-4） */
import { describe, expect, it } from "vitest";
import { evaluateRules, type EnterpriseRule, type RuleContext } from "./rules.js";

const ctx: RuleContext = { featureType: "POCKET", materialFamily: "Al", toolType: "FLAT_END_MILL", toolDiameterMm: 8 };

const rules: EnterpriseRule[] = [
  {
    id: "r_ai_speed",
    name: "AI 优化转速",
    scope: "AI",
    applies_to_features: [],
    clauses: [{ kind: "numeric", numeric: { param: "spindle_speed_rpm", mode: "abs", value: 9000 } }],
    enabled: true,
  },
  {
    id: "r_tool_max_speed",
    name: "刀具转速上限",
    scope: "TOOL",
    applies_to_features: [],
    applies_to_tools: ["FLAT_END_MILL"],
    clauses: [{ kind: "numeric", numeric: { param: "spindle_speed_rpm", mode: "max", value: 7500 } }],
    enabled: true,
  },
  {
    id: "r_mat_coolant",
    name: "铝材冷却",
    scope: "MATERIAL",
    applies_to_features: [],
    applies_to_material: ["Al"],
    clauses: [{ kind: "coolant", coolant: "FLOOD" }],
    enabled: true,
  },
  {
    id: "r_ent_step",
    name: "企业步深上限",
    scope: "ENTERPRISE",
    applies_to_features: ["POCKET"],
    clauses: [{ kind: "numeric", numeric: { param: "stepdown_mm", mode: "max", value: 0.5 } }],
    enabled: true,
  },
];

describe("优先级折叠", () => {
  it("AI 转速被刀具上限覆盖（TOOL > AI），决策链保留两条", () => {
    const r = evaluateRules(rules, ctx, { spindle_speed_rpm: 6000 });
    expect(r.params.spindle_speed_rpm).toBe(7500); // min(9000, 7500) 且 max 模式基于 6000 生效前
    expect(r.decisions.length).toBeGreaterThanOrEqual(2);
    expect(r.overridden.length).toBeGreaterThanOrEqual(1);
  });

  it("企业规则步深上限生效（ENTERPRISE 最高）", () => {
    const r = evaluateRules(rules, ctx, { stepdown_mm: 2 });
    expect(r.params.stepdown_mm).toBe(0.5);
    const ent = r.decisions.find((d) => d.scope === "ENTERPRISE");
    expect(ent?.effect).toContain("0.5");
  });

  it("材料规则设置冷却", () => {
    const r = evaluateRules(rules, ctx);
    expect(r.params.coolant).toBe("FLOOD");
  });
});

describe("禁刀规则", () => {
  it("命中禁刀：规则终止并记入 overridden（调用方据 decisions 排除候选）", () => {
    const ban: EnterpriseRule = {
      id: "r_ban_ball",
      name: "禁球刀开粗",
      scope: "ENTERPRISE",
      applies_to_features: ["POCKET"],
      applies_to_tools: ["BALL_END_MILL"],
      clauses: [{ kind: "forbid_tool_type", tool_types: ["BALL_END_MILL"] }],
      enabled: true,
    };
    const r = evaluateRules([ban], { ...ctx, toolType: "BALL_END_MILL" });
    expect(r.overridden.some((d) => d.rule_id === "r_ban_ball" && d.effect.includes("禁刀"))).toBe(true);
    expect(r.params).toEqual({});
  });

  it("不同刀具类型不受禁刀影响", () => {
    const ban: EnterpriseRule = {
      id: "r_ban_ball",
      name: "禁球刀开粗",
      scope: "ENTERPRISE",
      applies_to_features: ["POCKET"],
      applies_to_tools: ["BALL_END_MILL"],
      clauses: [{ kind: "forbid_tool_type", tool_types: ["BALL_END_MILL"] }],
      enabled: true,
    };
    const r = evaluateRules([ban], { ...ctx, toolType: "FLAT_END_MILL" });
    expect(r.params).toEqual({});
  });
});

describe("适用范围", () => {
  it("特征类型不匹配的规则不生效", () => {
    const r = evaluateRules(rules, { ...ctx, featureType: "HOLE_BLIND" }, { stepdown_mm: 2 });
    expect(r.params.stepdown_mm).toBe(2);
  });

  it("禁用规则跳过", () => {
    const off: EnterpriseRule = { ...rules[3], id: "r_off", enabled: false };
    const r = evaluateRules([off], ctx, { stepdown_mm: 2 });
    expect(r.params.stepdown_mm).toBe(2);
  });
});

describe("paramKey 显式化（P3-26）", () => {
  it("每条决策携带显式 paramKey，可按参数直接分组（不依赖 clause_desc 反解）", () => {
    const r = evaluateRules(rules, ctx, { spindle_speed_rpm: 6000 });
    const speed = r.decisions.filter((d) => d.paramKey === "spindle_speed_rpm");
    expect(speed.length).toBeGreaterThanOrEqual(1);
    // coolant 决策也有显式 key
    expect(r.decisions.some((d) => d.paramKey === "coolant")).toBe(true);
    // stepdown 企业规则
    expect(r.decisions.some((d) => d.paramKey === "stepdown_mm")).toBe(true);
  });

  it("同参数多规则命中时按显式 paramKey 折叠，后赢者胜出、早期者入 overridden", () => {
    const r = evaluateRules(rules, ctx, { spindle_speed_rpm: 6000 });
    expect(r.params.spindle_speed_rpm).toBe(7500);
    // AI 与 TOOL 都动 spindle_speed_rpm：AI 被折叠进 overridden
    expect(r.overridden.some((d) => d.paramKey === "spindle_speed_rpm" && d.scope === "AI")).toBe(true);
    // 胜出者唯一
    const winners = r.decisions.filter((d) => d.paramKey === "spindle_speed_rpm");
    expect(winners).toHaveLength(1);
  });
});
