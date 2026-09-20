/**
 * 主数据种子数据（Phase 1）
 * 组织：org_demo。值取行业典型参数（来源 STANDARD/EXPERT），供演示与回归；
 * 生产环境由工厂录入并落库（迁移 0002 表结构 + 此处 JSON 作为初始种子）。
 */
import type { Controller, CuttingRule, Machine, Material, Tool } from "@ai-cam/domain-schemas";

const NOW = "2026-09-20T00:00:00.000Z";

export const SEED_ORG_ID = "org_demo";

export const seedMachines: Machine[] = [
  {
    id: "mch_vmc850",
    organization_id: SEED_ORG_ID,
    name: "VMC-850 三轴加工中心",
    model: "VMC850",
    manufacturer: "通用",
    axis_config: "3AXIS",
    kinematics: {
      axis_config: "3AXIS",
      travel: { x: 800, y: 500, z: 500 },
      max_spindle_rpm: 8000,
      max_feed_mm_min: 12000,
      rapid_mm_min: 24000,
      table_size_mm: { x: 1000, y: 500 },
      work_cube_mm: { x: 800, y: 450, z: 450 },
    },
    supported_controllers: ["ctl_fanuc_0imf", "ctl_syntec_21ma"],
    status: "AVAILABLE",
    version: 0,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "mch_vmc1160",
    organization_id: SEED_ORG_ID,
    name: "VMC-1160 三轴加工中心",
    model: "VMC1160",
    manufacturer: "通用",
    axis_config: "3AXIS",
    kinematics: {
      axis_config: "3AXIS",
      travel: { x: 1100, y: 600, z: 600 },
      max_spindle_rpm: 10000,
      max_feed_mm_min: 12000,
      rapid_mm_min: 24000,
      table_size_mm: { x: 1200, y: 600 },
      work_cube_mm: { x: 1100, y: 550, z: 550 },
    },
    supported_controllers: ["ctl_fanuc_0imf", "ctl_mitsubishi_m80"],
    status: "AVAILABLE",
    version: 0,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "mch_vmc850_4ax",
    organization_id: SEED_ORG_ID,
    name: "VMC-850 四轴加工中心（A 轴转台）",
    model: "VMC850-4AX",
    manufacturer: "通用",
    axis_config: "4AXIS",
    kinematics: {
      axis_config: "4AXIS",
      travel: { x: 800, y: 500, z: 500 },
      rotation_axis: "A",
      max_spindle_rpm: 8000,
      max_feed_mm_min: 12000,
      rapid_mm_min: 24000,
      table_size_mm: { x: 300, y: 300 },
    },
    supported_controllers: ["ctl_fanuc_0imf"],
    status: "AVAILABLE",
    version: 0,
    created_at: NOW,
    updated_at: NOW,
  },
];

export const seedControllers: Controller[] = [
  {
    id: "ctl_fanuc_0imf",
    name: "Fanuc 0i-MF",
    dialect: "FANUC",
    post_version: "0.1.0",
    capabilities: ["DRILLING_CYCLES", "CANNED_CYCLES", "HIGH_SPEED"],
    version: 0,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "ctl_syntec_21ma",
    name: "Syntec 21MA",
    dialect: "SYNTEC",
    post_version: "0.1.0",
    capabilities: ["DRILLING_CYCLES", "CANNED_CYCLES"],
    version: 0,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "ctl_mitsubishi_m80",
    name: "Mitsubishi M80",
    dialect: "MITSUBISHI",
    post_version: "0.1.0",
    capabilities: ["DRILLING_CYCLES", "CANNED_CYCLES", "HIGH_SPEED"],
    version: 0,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: "ctl_iso_generic",
    name: "ISO 通用",
    dialect: "ISO_GENERIC",
    post_version: "0.1.0",
    capabilities: ["DRILLING_CYCLES"],
    version: 0,
    created_at: NOW,
    updated_at: NOW,
  },
];

export const seedTools: Tool[] = [
  { id: "tool_em_3", organization_id: SEED_ORG_ID, name: "平刀 Ø3", type: "FLAT_END_MILL", tool_material: "CARBIDE_COATED", diameter_mm: 3, flute_length_mm: 10, overall_length_mm: 50, corner_radius_mm: 0, flute_count: 3, flute: "3F", coating: "TIALN", stock_qty: 4, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_em_6", organization_id: SEED_ORG_ID, name: "平刀 Ø6", type: "FLAT_END_MILL", tool_material: "CARBIDE_COATED", diameter_mm: 6, flute_length_mm: 20, overall_length_mm: 60, corner_radius_mm: 0, flute_count: 4, flute: "4F", coating: "TIALN", stock_qty: 8, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_em_8", organization_id: SEED_ORG_ID, name: "平刀 Ø8", type: "FLAT_END_MILL", tool_material: "CARBIDE_COATED", diameter_mm: 8, flute_length_mm: 25, overall_length_mm: 75, corner_radius_mm: 0, flute_count: 4, flute: "4F", coating: "TIALN", stock_qty: 6, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_em_10", organization_id: SEED_ORG_ID, name: "平刀 Ø10", type: "FLAT_END_MILL", tool_material: "CARBIDE_COATED", diameter_mm: 10, flute_length_mm: 30, overall_length_mm: 75, corner_radius_mm: 0, flute_count: 4, flute: "4F", coating: "TIALN", stock_qty: 6, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_em_12", organization_id: SEED_ORG_ID, name: "平刀 Ø12", type: "FLAT_END_MILL", tool_material: "CARBIDE_COATED", diameter_mm: 12, flute_length_mm: 32, overall_length_mm: 80, corner_radius_mm: 0, flute_count: 4, flute: "4F", coating: "TIALN", stock_qty: 4, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_em_16", organization_id: SEED_ORG_ID, name: "平刀 Ø16", type: "FLAT_END_MILL", tool_material: "CARBIDE", diameter_mm: 16, flute_length_mm: 45, overall_length_mm: 100, corner_radius_mm: 0, flute_count: 4, flute: "4F", coating: "ALCRN", stock_qty: 2, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_ball_3", organization_id: SEED_ORG_ID, name: "球刀 Ø3", type: "BALL_END_MILL", tool_material: "CARBIDE_COATED", diameter_mm: 3, flute_length_mm: 10, overall_length_mm: 50, corner_radius_mm: 1.5, flute_count: 2, flute: "2F", coating: "TIALN", stock_qty: 4, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_ball_4", organization_id: SEED_ORG_ID, name: "球刀 Ø4", type: "BALL_END_MILL", tool_material: "CARBIDE_COATED", diameter_mm: 4, flute_length_mm: 12, overall_length_mm: 50, corner_radius_mm: 2, flute_count: 2, flute: "2F", coating: "TIALN", stock_qty: 4, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_ball_6", organization_id: SEED_ORG_ID, name: "球刀 Ø6", type: "BALL_END_MILL", tool_material: "CARBIDE_COATED", diameter_mm: 6, flute_length_mm: 15, overall_length_mm: 60, corner_radius_mm: 3, flute_count: 2, flute: "2F", coating: "TIALN", stock_qty: 4, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_bull_10", organization_id: SEED_ORG_ID, name: "牛鼻刀 Ø10 R1", type: "BULL_NOSE", tool_material: "CARBIDE_COATED", diameter_mm: 10, flute_length_mm: 25, overall_length_mm: 75, corner_radius_mm: 1, flute_count: 4, flute: "4F", coating: "ALCRN", stock_qty: 2, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_drill_3.3", organization_id: SEED_ORG_ID, name: "麻花钻 Ø3.3（M4 底孔）", type: "DRILL", tool_material: "HSS", diameter_mm: 3.3, flute_length_mm: 35, overall_length_mm: 70, corner_radius_mm: 0, flute_count: 2, flute: "2F", coating: "NONE", stock_qty: 10, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_drill_5", organization_id: SEED_ORG_ID, name: "麻花钻 Ø5", type: "DRILL", tool_material: "HSS", diameter_mm: 5, flute_length_mm: 45, overall_length_mm: 85, corner_radius_mm: 0, flute_count: 2, flute: "2F", coating: "NONE", stock_qty: 8, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_drill_6.8", organization_id: SEED_ORG_ID, name: "麻花钻 Ø6.8（M8 底孔）", type: "DRILL", tool_material: "HSS", diameter_mm: 6.8, flute_length_mm: 55, overall_length_mm: 95, corner_radius_mm: 0, flute_count: 2, flute: "2F", coating: "NONE", stock_qty: 6, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_drill_8.5", organization_id: SEED_ORG_ID, name: "麻花钻 Ø8.5", type: "DRILL", tool_material: "HSS", diameter_mm: 8.5, flute_length_mm: 60, overall_length_mm: 100, corner_radius_mm: 0, flute_count: 2, flute: "2F", coating: "NONE", stock_qty: 6, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_drill_10.2", organization_id: SEED_ORG_ID, name: "麻花钻 Ø10.2", type: "DRILL", tool_material: "HSS", diameter_mm: 10.2, flute_length_mm: 65, overall_length_mm: 110, corner_radius_mm: 0, flute_count: 2, flute: "2F", coating: "NONE", stock_qty: 4, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_chamfer_6", organization_id: SEED_ORG_ID, name: "倒角刀 90° Ø6", type: "CHAMFER", tool_material: "CARBIDE", diameter_mm: 6, flute_length_mm: 15, overall_length_mm: 50, corner_radius_mm: 0, flute_count: 4, flute: "4F", coating: "TIALN", stock_qty: 4, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_engrave_02", organization_id: SEED_ORG_ID, name: "雕刻刀 Ø0.2", type: "ENGRAVING", tool_material: "CARBIDE", diameter_mm: 0.2, flute_length_mm: 3, overall_length_mm: 38, corner_radius_mm: 0.1, flute_count: 2, flute: "2F", coating: "DLC", stock_qty: 6, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_deburr_6", organization_id: SEED_ORG_ID, name: "去毛刺刀 Ø6", type: "DEBURR", tool_material: "CARBIDE", diameter_mm: 6, flute_length_mm: 15, overall_length_mm: 50, corner_radius_mm: 0, flute_count: 4, flute: "4F", coating: "TIALN", stock_qty: 3, version: 0, created_at: NOW, updated_at: NOW },
  { id: "tool_thread_m6", organization_id: SEED_ORG_ID, name: "螺纹铣刀 M6", type: "THREAD_MILL", tool_material: "CARBIDE", diameter_mm: 5, flute_length_mm: 12, overall_length_mm: 50, corner_radius_mm: 0, flute_count: 3, flute: "3F", coating: "TIALN", stock_qty: 3, version: 0, created_at: NOW, updated_at: NOW },
];

export const seedMaterials: Material[] = [
  { id: "mat_al_6061", organization_id: SEED_ORG_ID, name: "铝 6061", category: "ALUMINUM", grade: "6061-T6", hardness: "95 HB", density_kg_m3: 2700, default_coolant: "FLOOD", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_al_7075", organization_id: SEED_ORG_ID, name: "铝 7075", category: "ALUMINUM", grade: "7075-T651", hardness: "150 HB", density_kg_m3: 2810, default_coolant: "FLOOD", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_st_45", organization_id: SEED_ORG_ID, name: "钢 45#", category: "STEEL", grade: "45#", hardness: "197 HB", density_kg_m3: 7850, default_coolant: "FLOOD", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_st_q235", organization_id: SEED_ORG_ID, name: "钢 Q235", category: "STEEL", grade: "Q235", hardness: "130 HB", density_kg_m3: 7850, default_coolant: "FLOOD", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_ss_304", organization_id: SEED_ORG_ID, name: "不锈钢 304", category: "STAINLESS", grade: "304", hardness: "187 HB", density_kg_m3: 7930, default_coolant: "FLOOD", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_ss_316", organization_id: SEED_ORG_ID, name: "不锈钢 316", category: "STAINLESS", grade: "316", hardness: "200 HB", density_kg_m3: 7980, default_coolant: "FLOOD", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_br_c360", organization_id: SEED_ORG_ID, name: "黄铜 C360", category: "BRASS", grade: "C36000", hardness: "80 HB", density_kg_m3: 8500, default_coolant: "MIST", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_cu_c110", organization_id: SEED_ORG_ID, name: "紫铜 C110", category: "COPPER", grade: "C11000", hardness: "45 HB", density_kg_m3: 8960, default_coolant: "FLOOD", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_pl_pom", organization_id: SEED_ORG_ID, name: "POM 赛钢", category: "PLASTIC", grade: "POM-C", density_kg_m3: 1410, default_coolant: "DRY", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_pl_peek", organization_id: SEED_ORG_ID, name: "PEEK 聚醚醚酮", category: "PLASTIC", grade: "PEEK", density_kg_m3: 1320, default_coolant: "DRY", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
  { id: "mat_ti_tc4", organization_id: SEED_ORG_ID, name: "钛 TC4", category: "TITANIUM", grade: "TC4", hardness: "36 HRC", density_kg_m3: 4430, default_coolant: "THROUGH", machinable: true, version: 0, created_at: NOW, updated_at: NOW },
];

const R = (
  id: string,
  material_id: string,
  tool_type: string,
  vc: [number, number],
  fz: [number, number],
  doc: [number, number],
  woc: [number, number],
  source: CuttingRule["source"] = "EXPERT",
): CuttingRule => ({
  id,
  material_id,
  tool_type,
  vc_range_m_min: { min: vc[0], max: vc[1] },
  fz_range_mm: { min: fz[0], max: fz[1] },
  doc_ratio_recommended: { min: doc[0], max: doc[1] },
  woc_ratio_recommended: { min: woc[0], max: woc[1] },
  source,
  effective_from: "2026-01-01",
  version: 0,
  created_at: NOW,
});

export const seedCuttingRules: CuttingRule[] = [
  R("cr_al6061_flat", "mat_al_6061", "FLAT_END_MILL", [200, 400], [0.03, 0.08], [0.5, 1.5], [0.3, 0.8]),
  R("cr_al6061_ball", "mat_al_6061", "BALL_END_MILL", [180, 350], [0.02, 0.06], [0.2, 0.6], [0.2, 0.5]),
  R("cr_al6061_drill", "mat_al_6061", "DRILL", [80, 120], [0.1, 0.25], [0.5, 1.5], [0.5, 1.5]),
  R("cr_al7075_flat", "mat_al_7075", "FLAT_END_MILL", [180, 320], [0.03, 0.07], [0.5, 1.2], [0.3, 0.7]),
  R("cr_st45_flat", "mat_st_45", "FLAT_END_MILL", [100, 180], [0.02, 0.05], [0.4, 1.0], [0.3, 0.6]),
  R("cr_st45_ball", "mat_st_45", "BALL_END_MILL", [90, 150], [0.015, 0.04], [0.2, 0.5], [0.2, 0.4]),
  R("cr_st45_drill", "mat_st_45", "DRILL", [40, 70], [0.08, 0.2], [0.5, 1.5], [0.5, 1.5]),
  R("cr_ss304_flat", "mat_ss_304", "FLAT_END_MILL", [60, 110], [0.015, 0.04], [0.3, 0.8], [0.2, 0.5]),
  R("cr_ss304_drill", "mat_ss_304", "DRILL", [25, 45], [0.05, 0.15], [0.5, 1.0], [0.5, 1.0]),
  R("cr_tc4_flat", "mat_ti_tc4", "FLAT_END_MILL", [40, 80], [0.01, 0.03], [0.2, 0.6], [0.15, 0.4]),
  R("cr_brass_flat", "mat_br_c360", "FLAT_END_MILL", [150, 300], [0.03, 0.08], [0.5, 1.5], [0.3, 0.8]),
  R("cr_pom_flat", "mat_pl_pom", "FLAT_END_MILL", [200, 400], [0.05, 0.12], [0.5, 1.5], [0.3, 1.0]),
  R("cr_peek_flat", "mat_pl_peek", "FLAT_END_MILL", [120, 250], [0.03, 0.08], [0.3, 1.0], [0.3, 0.8]),
];

export const MASTER_DATA_VERSION = "0.1.0";
