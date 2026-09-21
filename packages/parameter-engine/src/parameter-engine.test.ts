/** 切削参数引擎测试（P2-9）：规则中值 / 约束 clamp / 硬约束 reject / 来源标注 */
import { describe, expect, it } from "vitest";
import { computeCuttingParameters, findCuttingRule, ParameterConstraintError } from "./index.js";
import { seedCuttingRules, seedMaterials, seedTools, seedMachines } from "@ai-cam/master-data";

const al6061 = seedMaterials.find((m) => m.id === "mat_al_6061")!;
const em6 = seedTools.find((t) => t.id === "tool_em_6")!;
const drill5 = seedTools.find((t) => t.id === "tool_drill_5")!;
const vmc850 = seedMachines.find((m) => m.id === "mch_vmc850")!;

describe("parameter-engine", () => {
  it("规则匹配：铝 6061 + 平刀命中 cr_al6061_flat", () => {
    const rule = findCuttingRule("mat_al_6061", "FLAT_END_MILL", seedCuttingRules);
    expect(rule?.id).toBe("cr_al6061_flat");
  });

  it("引擎计算：Vc→RPM、fz→Feed 符合规则区间", () => {
    const r = computeCuttingParameters({
      tool: em6,
      material: al6061,
      opType: "POCKET",
      machine: { max_spindle_rpm: vmc850.kinematics.max_spindle_rpm, max_feed_mm_min: vmc850.kinematics.max_feed_mm_min },
    });
    const rpm = r.parameters.spindle_speed_rpm;
    const feed = r.parameters.feed_mm_min;
    // Vc 300 中值 / Ø6 → 15915rpm → 超过 8000 → clamp 到 8000（decision 记录）
    expect(rpm).toBeLessThanOrEqual(8000);
    expect(feed).toBeGreaterThan(0);
    expect(r.parameters.source).toBe("ENGINE");
    expect(r.decisions.length).toBeGreaterThanOrEqual(5);
    const rpmDec = r.decisions.find((d) => d.parameter === "spindle_speed_rpm");
    expect(rpmDec?.action).toBe("CLAMPED"); // 15915 > 8000
    expect(rpmDec?.machine_max).toBe(8000);
    expect(rpmDec?.value).toBe(8000);
    // 所有数值为正且不超机床硬约束
    expect(r.parameters.feed_mm_min).toBeLessThanOrEqual(12000);
    expect(r.parameters.plunge_feed_mm_min!).toBeLessThanOrEqual(12000);
    expect(r.parameters.stepdown_mm!).toBeGreaterThan(0);
    expect(r.parameters.stepover_mm!).toBeGreaterThan(0);
  });

  it("钻孔工序：不输出 stepover，Plunge 独立", () => {
    const r = computeCuttingParameters({
      tool: drill5,
      material: al6061,
      opType: "DRILL",
    });
    expect(r.parameters.stepover_mm).toBeUndefined();
    expect(r.parameters.stepdown_mm).toBeGreaterThan(0);
    expect(r.parameters.plunge_feed_mm_min!).toBeGreaterThan(0);
    expect(r.parameters.coolant).toBe("FLOOD");
  });

  it("用户/AI 覆盖优先（来源 USER），仍受机床硬约束 clamp", () => {
    const r = computeCuttingParameters({
      tool: em6,
      material: al6061,
      opType: "POCKET",
      machine: { max_spindle_rpm: 8000, max_feed_mm_min: 12000 },
      userOverrides: { spindle_speed_rpm: 100000, feed_mm_min: 5000 },
    });
    expect(r.parameters.source).toBe("USER");
    expect(r.parameters.spindle_speed_rpm).toBe(8000); // clamp
    const dec = r.decisions.find((d) => d.parameter === "spindle_speed_rpm");
    expect(dec?.action).toBe("CLAMPED");
    expect(dec?.requested).toBe(100000);
  });

  it("无规则材料（未知）→ 保守默认值，来源 DEFAULT", () => {
    const r = computeCuttingParameters({
      tool: em6,
      material: { id: "mat_unknown", default_coolant: "FLOOD" },
      opType: "FACE",
    });
    expect(r.parameters.source).toBe("DEFAULT");
    expect(r.parameters.spindle_speed_rpm).toBeGreaterThan(0);
  });

  it("rulePolicy=reject：规则区间外直接拒绝", () => {
    expect(() =>
      computeCuttingParameters({
        tool: em6,
        material: al6061,
        opType: "POCKET",
        userOverrides: { spindle_speed_rpm: 25000 },
        rulePolicy: "reject",
      }),
    ).toThrowError(ParameterConstraintError);
  });

  it("reject 路径抛出的错误携带 typed code = CAM_PARAMETER_OUT_OF_RANGE", () => {
    expect.assertions(3);
    try {
      computeCuttingParameters({
        tool: em6,
        material: al6061,
        opType: "POCKET",
        userOverrides: { spindle_speed_rpm: 25000 },
        rulePolicy: "reject",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ParameterConstraintError);
      expect((e as { code?: string }).code).toBe("CAM_PARAMETER_OUT_OF_RANGE");
      expect((e as ParameterConstraintError).decisions.some((d) => d.action === "REJECTED")).toBe(true);
    }
  });

  it("机床极限过低：clamp 到上限并标记保守加工（不 reject）", () => {
    // 机床 max_rpm=500（远低于铝 6061 平刀规则下限 ~10610rpm）
    const r = computeCuttingParameters({
      tool: em6,
      material: al6061,
      opType: "POCKET",
      machine: { max_spindle_rpm: 500, max_feed_mm_min: 12000 },
      userOverrides: { spindle_speed_rpm: 600 },
    });
    expect(r.parameters.spindle_speed_rpm).toBe(500);
    const dec = r.decisions.find((d) => d.parameter === "spindle_speed_rpm");
    expect(dec?.action).toBe("CLAMPED");
    expect(dec?.reason).toContain("保守加工");
  });
});
