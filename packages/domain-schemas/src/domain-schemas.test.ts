import { describe, expect, it } from "vitest";
import { Machine, Controller, Tool, ToolAssembly, Material, CuttingRule, Feature, FeatureGraph } from "./index.js";

describe("domain-schemas", () => {
  it("Machine schema 通过合法数据", () => {
    const m = Machine.parse({
      id: "m_vmc_3axis",
      organization_id: "org_1",
      name: "VMC-850",
      axis_config: "3AXIS",
      kinematics: {
        axis_config: "3AXIS",
        travel: { x: 850, y: 500, z: 500 },
        max_spindle_rpm: 12000,
        max_feed_mm_min: 20000,
        rapid_mm_min: 48000,
      },
      supported_controllers: ["c_fanuc"],
      version: 0,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    });
    expect(m.axis_config).toBe("3AXIS");
    expect(m.kinematics.travel.x).toBe(850);
  });

  it("Controller 区分指令集族与 Post 版本", () => {
    const c = Controller.parse({
      id: "c_fanuc",
      name: "Fanuc Oi-MF",
      dialect: "FANUC",
      post_version: "1.0.0",
      version: 0,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    });
    expect(c.dialect).toBe("FANUC");
  });

  it("Tool + ToolAssembly（伸出量参与碰撞判定）", () => {
    const t = Tool.parse({
      id: "t_em10",
      organization_id: "org_1",
      name: "EM 10mm 4F",
      type: "FLAT_END_MILL",
      tool_material: "CARBIDE",
      diameter_mm: 10,
      flute_length_mm: 25,
      overall_length_mm: 75,
      corner_radius_mm: 0,
      version: 0,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    });
    const a = ToolAssembly.parse({
      id: "ta_1",
      organization_id: "org_1",
      name: "BT40-ER32 75mm",
      holder: { type: "BT40", gauge_length_mm: 60 },
      reach_mm: 75,
      tool_id: "t_em10",
      version: 0,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    });
    expect(a.reach_mm).toBeGreaterThan(t.flute_length_mm);
  });

  it("Material + CuttingRule 版本与生效区间", () => {
    const mat = Material.parse({
      id: "mat_6061",
      organization_id: "org_1",
      name: "6061 Aluminum",
      category: "ALUMINUM",
      grade: "T6",
      version: 0,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    });
    const rule = CuttingRule.parse({
      id: "rule_1",
      material_id: "mat_6061",
      tool_type: "FLAT_END_MILL",
      vc_range_m_min: { min: 300, max: 600 },
      fz_range_mm: { min: 0.02, max: 0.08 },
      doc_ratio_recommended: { min: 0.5, max: 1.5 },
      woc_ratio_recommended: { min: 0.05, max: 0.5 },
      source: "EXPERT",
      effective_from: "2026-01-01",
      version: 1,
      created_at: "2026-09-20T00:00:00Z",
    });
    expect(mat.category).toBe("ALUMINUM");
    expect(rule.vc_range_m_min.max).toBe(600);
  });

  it("Feature + FeatureGraph（置信度与可访问方向）", () => {
    const f = Feature.parse({
      id: "F1",
      type: "POCKET",
      confidence: 0.97,
      source_face_ids: ["face_1", "face_2"],
      bbox: { min: { x: 10, y: 10, z: 0 }, max: { x: 30, y: 40, z: 8 } },
      accessible_directions: ["+Z"],
      dimensions: { width_mm: 20, length_mm: 30, depth_mm: 8 },
      recognizer_version: "0.1.0",
    });
    const g = FeatureGraph.parse({
      part_id: "part_1",
      features: [f],
      recognizer_version: "0.1.0",
      created_at: "2026-09-20T00:00:00Z",
    });
    expect(g.features[0].confidence).toBeGreaterThan(0.9);
  });
});
