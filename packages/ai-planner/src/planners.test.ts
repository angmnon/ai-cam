/** 程序化规划器测试（P4-5/6/7） */
import { describe, expect, it } from "vitest";
import { seedTools } from "@ai-cam/master-data";
import type { Feature } from "@ai-cam/domain-schemas";
import { planSetups } from "./setup.js";
import { planProcess, validateOrder, type OpType } from "./process.js";
import { planTool } from "./tool.js";

const f = (id: string, type: Feature["type"], accessible: Feature["accessible_directions"] = ["+Z"]): Feature => ({
  id,
  type,
  confidence: 0.9,
  source_face_ids: [],
  bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 } },
  accessible_directions: accessible,
  dimensions: {},
  recognizer_version: "1.0.0",
  recognized_by: "ENGINE",
});

describe("planSetups（P4-5）", () => {
  it("single_side_z：一个 +Z setup，覆盖全部特征", () => {
    const feats = [f("F1", "OUTER_PROFILE"), f("F2", "POCKET")];
    const plans = planSetups(feats, { preference: "single_side_z" as const });
    expect(plans.length).toBe(1);
    expect(plans[0].id).toBe("setup_z");
    expect(plans[0].coverage).toBe(1);
    expect(plans[0].wcs).toBe("G54");
  });

  it("two_side_z：通孔底部特征进入第二 setup", () => {
    const feats = [f("F1", "OUTER_PROFILE"), f("F2", "HOLE_BLIND", ["-Z"])];
    const plans = planSetups(feats, { preference: "two_side_z" as const });
    expect(plans.length).toBe(2);
    const flip = plans.find((p) => p.id === "setup_z_flip");
    expect(flip).toBeTruthy();
    expect(flip!.covered_feature_ids).toContain("F2");
    // 单面方案评分（少装夹）通常更高或持平
    expect(plans[0].coverage).toBeGreaterThanOrEqual(plans[plans.length - 1].coverage);
  });

  it("评分可解释且排序稳定", () => {
    const feats = [f("F1", "OUTER_PROFILE"), f("F2", "POCKET")];
    const plans = planSetups(feats);
    for (const p of plans) expect(p.reasons.some((r) => r.startsWith("评分="))).toBe(true);
    expect(plans[0].score).toBeGreaterThanOrEqual(plans[plans.length - 1].score);
  });
});

describe("planProcess（P4-6）", () => {
  it("FACE 先于 POCKET/DRILL，CHAMFER 最后", () => {
    const feats = [f("F1", "OUTER_PROFILE"), f("F2", "POCKET"), f("F3", "HOLE_BLIND"), f("F4", "CHAMFER")];
    const p = planProcess(feats);
    expect(p.validation.ok).toBe(true);
    expect(p.order[0]).toBe("FACE");
    expect(p.order[p.order.length - 1]).toBe("CHAMFER");
    expect(p.order.indexOf("FACE")).toBeLessThan(p.order.indexOf("DRILL"));
  });

  it("DRILL_LAST 偏好生效且不违反规则", () => {
    const feats = [f("F1", "OUTER_PROFILE"), f("F2", "HOLE_BLIND")];
    const p = planProcess(feats, { preference: "DRILL_LAST" as const });
    expect(p.order[p.order.length - 1]).toBe("DRILL");
    expect(p.validation.ok).toBe(true);
    expect(p.reasons.some((r) => r.includes("DRILL_LAST"))).toBe(true);
  });

  it("依赖规则校验：FACE 在 POCKET 之后 → 拒绝", () => {
    const r = validateOrder(["POCKET", "FACE", "CHAMFER"] as OpType[]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("FACE");
  });

  it("偏好冲突回退后 validation 反映最新 order（P2-36）", () => {
    // DRILL_LAST 与 CHAMFER mustFollow DRILL 冲突：DRILL 被移到 CHAMFER 之后
    const feats = [f("F1", "OUTER_PROFILE"), f("F2", "HOLE_BLIND"), f("F3", "CHAMFER")];
    const p = planProcess(feats, { preference: "DRILL_LAST" as const });
    // 回退后 order 为规则默认顺序：CHAMFER 在最后
    expect(p.order[p.order.length - 1]).toBe("CHAMFER");
    expect(p.order[p.order.length - 2]).toBe("DRILL");
    // P2-36：validation 必须与回退后的 order 自洽（旧 bug 此处为 false）
    expect(p.validation.ok).toBe(true);
    expect(p.reasons.some((r) => r.includes("回退"))).toBe(true);
  });
});

describe("planTool（P4-7）", () => {
  it("DRILL 近径匹配 + 可解释评分", () => {
    const r = planTool("DRILL", { preferDrillOf: 5 }, seedTools, { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 });
    expect(r.tool.type).toBe("DRILL");
    expect(Math.abs(r.tool.diameter_mm - 5)).toBeLessThanOrEqual(1.5);
    expect(r.rank_reason.length).toBeGreaterThan(2);
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it("FACE 用 ≤ 约束直径的最大平刀", () => {
    const r = planTool("FACE", { maxDiameter: 10 }, seedTools);
    expect(r.tool.type).toBe("FLAT_END_MILL");
    expect(r.tool.diameter_mm).toBeLessThanOrEqual(10);
    expect(r.score).toBeGreaterThan(0);
  });

  it("用户权重影响排序（cost_first 选更小刀）", () => {
    const costFirst = planTool("FACE", { maxDiameter: 16 }, seedTools, { diameter_match: 0.2, tool_cost: 0.7, surface_quality: 0.1 });
    const qualityFirst = planTool("FACE", { maxDiameter: 16 }, seedTools, { diameter_match: 0.3, tool_cost: 0.1, surface_quality: 0.6 });
    expect(costFirst.tool.diameter_mm).toBeLessThanOrEqual(qualityFirst.tool.diameter_mm);
  });
});
