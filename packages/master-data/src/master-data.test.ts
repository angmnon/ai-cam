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

  it("getMasterData 不传 orgId 返回全量（向后兼容）", () => {
    const bundle = getMasterData();
    expect(bundle.machines.length).toBe(seedMachines.length);
    expect(bundle.tools.length).toBe(seedTools.length);
    expect(bundle.materials.length).toBe(seedMaterials.length);
  });

  it("getMasterData 传 orgId 只返回该 org 的数据", () => {
    // 种子数据全部归属 org_demo；传其它 org 应得到空的租户维度集合，
    // 而不带 organization_id 的控制器/切削规则仍全量返回。
    const bundle = getMasterData("org_unknown");
    expect(bundle.machines.length).toBe(0);
    expect(bundle.tools.length).toBe(0);
    expect(bundle.materials.length).toBe(0);
    expect(bundle.controllers.length).toBe(seedControllers.length);
    expect(bundle.cutting_rules.length).toBe(seedCuttingRules.length);

    // 传 org_demo：仅含该 org 的机器/刀具/材料，且无越权数据
    const demo = getMasterData("org_demo");
    expect(demo.machines.every((m) => m.organization_id === "org_demo")).toBe(true);
    expect(demo.tools.every((t) => t.organization_id === "org_demo")).toBe(true);
    expect(demo.materials.every((m) => m.organization_id === "org_demo")).toBe(true);
  });
});
