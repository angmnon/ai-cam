/** Guardrails 测试（P4-4）：非法输出被拒、合法通过、引用一致性 */
import { describe, expect, it } from "vitest";
import { validatePlannerOutput, validatePlannerRefs } from "./guardrails.js";

describe("validatePlannerOutput（P4-4）", () => {
  it("合法输出通过", () => {
    const r = validatePlannerOutput({ strategy: "rough_then_finish", setup_preference: "single_side_z", process_order: "FACE_FIRST", tool_weights: { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 } });
    expect(r.ok).toBe(true);
    expect(r.value?.strategy).toBe("rough_then_finish");
  });

  it("非法枚举被拒", () => {
    const r = validatePlannerOutput({ strategy: "HACK", setup_preference: "single_side_z", process_order: "FACE_FIRST", tool_weights: { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 } });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.path === "strategy")).toBe(true);
  });

  it("tool_weights 之和 ≠ 1 被拒", () => {
    const r = validatePlannerOutput({ strategy: "rough_then_finish", setup_preference: "single_side_z", process_order: "FACE_FIRST", tool_weights: { diameter_match: 0.9, tool_cost: 0.2, surface_quality: 0.3 } });
    expect(r.ok).toBe(false);
    expect(r.violations[0].message).toContain("之和必须为 1");
  });

  it("overrides 越界被拒", () => {
    const r = validatePlannerOutput({ strategy: "rough_then_finish", setup_preference: "single_side_z", process_order: "FACE_FIRST", tool_weights: { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 }, overrides: { stepdown_mm: 99 } });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.path === "overrides.stepdown_mm")).toBe(true);
  });

  it("非 JSON 内容（如纯文本）被拒", () => {
    const r = validatePlannerOutput("I will plan this part");
    expect(r.ok).toBe(false);
  });
});

describe("validatePlannerRefs（引用/ACL）", () => {
  it("DRILL_LAST 且无钻孔特征 → 拒绝", () => {
    const r = validatePlannerRefs({ strategy: "rough_then_finish", setup_preference: "single_side_z", process_order: "DRILL_LAST", tool_weights: { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 } }, { featureCount: 3, hasDrills: false });
    expect(r.ok).toBe(false);
    expect(r.violations[0].message).toContain("DRILL_LAST");
  });

  it("有钻孔特征时通过", () => {
    const r = validatePlannerRefs({ strategy: "rough_then_finish", setup_preference: "single_side_z", process_order: "DRILL_LAST", tool_weights: { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 } }, { featureCount: 3, hasDrills: true });
    expect(r.ok).toBe(true);
  });
});
