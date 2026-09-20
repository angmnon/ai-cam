/** 主数据种子校验：schema 通过、数量与过滤正确 */
import { describe, expect, it } from "vitest";
import { getMasterData, seedControllers, seedCuttingRules, seedMachines, seedMaterials, seedTools, validateSeeds } from "../src/index.js";

describe("master-data seeds", () => {
  it("全部种子通过 domain-schemas 校验", () => {
    expect(() => validateSeeds()).not.toThrow();
  });

  it("数量与种类满足 Phase 1 需求", () => {
    expect(seedMachines.length).toBeGreaterThanOrEqual(3);
    expect(seedControllers.length).toBeGreaterThanOrEqual(4);
    expect(seedTools.length).toBeGreaterThanOrEqual(15);
    expect(seedMaterials.length).toBeGreaterThanOrEqual(8);
    expect(seedCuttingRules.length).toBeGreaterThanOrEqual(10);

    const toolTypes = new Set(seedTools.map((t) => t.type));
    expect(toolTypes.has("FLAT_END_MILL")).toBe(true);
    expect(toolTypes.has("DRILL")).toBe(true);
    expect(toolTypes.has("BALL_END_MILL")).toBe(true);
  });

  it("getMasterData 按组织过滤且引用完整", () => {
    const bundle = getMasterData("org_demo");
    expect(bundle.machines.every((m) => m.organization_id === "org_demo")).toBe(true);
    expect(bundle.tools.length).toBe(seedTools.length);
    // 每台机床引用的控制器都存在
    const ctrlIds = new Set(bundle.controllers.map((c) => c.id));
    for (const m of bundle.machines) {
      for (const c of m.supported_controllers) expect(ctrlIds.has(c)).toBe(true);
    }
    // 每条切削规则引用的材料存在
    const matIds = new Set(bundle.materials.map((m) => m.id));
    for (const r of bundle.cutting_rules) expect(matIds.has(r.material_id)).toBe(true);
  });
});
