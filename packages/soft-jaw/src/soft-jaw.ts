/**
 * 软爪生成 MVP（P5-3）：从零件包围盒与夹持面生成参数化软爪（SOFT_JAW）模型，
 * 输出可复现的参数描述 + OBJ 三角网格（前端 Three.js 可预览）。
 * 真实 STEP 实体导出依赖 OCCT Worker（P5 收尾项），本包为参数化几何源。
 */
export interface SoftJawParams {
  /** 爪体长（沿零件 Y，mm） */
  length_mm: number;
  /** 爪体宽（沿夹持方向 X，mm） */
  width_mm: number;
  /** 爪体高（沿 Z，mm） */
  height_mm: number;
  /** 夹持槽宽（零件该向厚度，mm） */
  slot_width_mm: number;
  /** 夹持槽深（进入爪体的深度，mm） */
  slot_depth_mm: number;
  /** 槽口圆角（mm） */
  fillet_mm: number;
  material: string;
}

export interface SoftJawModel {
  id: string;
  name: string;
  params: SoftJawParams;
  /** 配合的零件夹具候选 id（fixture-engine） */
  fixture_id: string;
  /** 夹持方向（+X/-X/+Y/-Y） */
  clamp_dir: string;
  generated_by: string;
  generator_version: string;
}

export function designSoftJaw(input: {
  partBBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  clampDir: "X" | "Y";
  clampDepthMm?: number;
  wallThicknessMm?: number;
  material?: string;
  fixtureId?: string;
}): SoftJawModel {
  const { min, max } = input.partBBox;
  const depth = input.clampDepthMm ?? 15;
  const wall = input.wallThicknessMm ?? 20;
  if (input.clampDir === "X") {
    // X 夹持：槽沿零件 Y 长方向，槽宽 = 零件 Y 厚
    const params: SoftJawParams = {
      length_mm: max.y - min.y + 2 * wall,
      width_mm: depth + wall,
      height_mm: max.z - min.z + wall,
      slot_width_mm: max.y - min.y,
      slot_depth_mm: depth,
      fillet_mm: 3,
      material: input.material ?? "6061-T6",
    };
    return { id: `jaw_x_${Math.round(params.slot_width_mm)}`, name: "软爪-X", params, fixture_id: input.fixtureId ?? "fx_softjaw_x", clamp_dir: "+X", generated_by: "soft-jaw", generator_version: "0.1.0" };
  }
  const params: SoftJawParams = {
    length_mm: max.x - min.x + 2 * wall,
    width_mm: depth + wall,
    height_mm: max.z - min.z + wall,
    slot_width_mm: max.x - min.x,
    slot_depth_mm: depth,
    fillet_mm: 3,
    material: input.material ?? "6061-T6",
  };
  return { id: `jaw_y_${Math.round(params.slot_width_mm)}`, name: "软爪-Y", params, fixture_id: input.fixtureId ?? "fx_softjaw_y", clamp_dir: "+Y", generated_by: "soft-jaw", generator_version: "0.1.0" };
}

/** OBJ 导出：爪体为带夹持槽的盒体（槽在夹持面一侧），顶点/面确定性生成 */
export function toObj(jaw: SoftJawModel): string {
  const p = jaw.params;
  const w = p.width_mm;
  const l = p.length_mm;
  const h = p.height_mm;
  const slotW = p.slot_width_mm;
  const slotD = p.slot_depth_mm;
  // 坐标系：X 为夹持深度方向，Y 沿零件长，Z 向上；槽从 X=w 面向内开
  // 参数语义：槽深 slotD 沿 X 向（槽底平面 X = w - slotD）；槽宽 slotW 沿 Y 向（沿爪长居中布置）
  const slotXBottom = w - slotD;
  const slotY0 = (l - slotW) / 2;
  const slotY1 = slotY0 + slotW;
  const vertices: [number, number, number][] = [
    // 爪体后壁（X=0）
    [0, 0, 0], [0, l, 0], [0, l, h], [0, 0, h],
    // 前壁外侧（X=w，未开槽部分：Y∈[0,slotY0] 与 Y∈[slotY1,l]）
    [w, 0, 0], [w, slotY0, 0], [w, slotY0, h], [w, 0, h],
    [w, slotY1, 0], [w, l, 0], [w, l, h], [w, slotY1, h],
    // 槽底（X=slotXBottom，Y∈[slotY0,slotY1]）
    [slotXBottom, slotY0, 0], [slotXBottom, slotY1, 0], [slotXBottom, slotY1, h], [slotXBottom, slotY0, h],
  ];
  const v = vertices.map(([x, y, z]) => `v ${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}`).join("\n");
  const faces = [
    "f 1 4 3 2", // 后壁
    "f 1 5 8 4", // 左下侧
    "f 1 2 6 5", // 底前段
    "f 2 3 10 6", // 右前下
    "f 5 6 9 12", // 槽内前
    "f 6 10 9", // 槽内前-连接
    "f 9 10 11 12", // 槽内右
    "f 12 11 14 13", // 槽底
    "f 13 14 15 16", // 槽底后
    "f 11 10 3 4 15 14", // 顶面（含槽口）
    "f 4 8 16 15", // 顶面后段
    "f 8 5 12 13 16", // 前端连接
  ];
  return `# SoftJaw ${jaw.id} (${jaw.generator_version})\n${v}\n${faces.join("\n")}\n`;
}

/** 爪体统计：体积估算（用于后续材料成本） */
export function estimateVolume(jaw: SoftJawModel): number {
  const p = jaw.params;
  const outer = p.width_mm * p.length_mm * p.height_mm;
  const slot = p.slot_depth_mm * p.slot_width_mm * p.height_mm;
  return Math.max(0, outer - slot);
}
