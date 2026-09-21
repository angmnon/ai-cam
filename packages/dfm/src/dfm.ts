/**
 * DFM 规则引擎 v1
 *
 * 输入：规范化零件模型 + MFG FeatureGraph。
 * 规则（ruler_version "0.1.0"）：
 *  DFM-0101 特征最小尺寸 < 刀具直径 → INFO
 *  DFM-0102 深腔（深/宽 > 3）→ WARNING；> 5 → BLOCKER
 *  DFM-0103 深孔（深/径 > 5）→ WARNING；> 8 → BLOCKER
 *  DFM-0104 内部特征距零件边缘 < 2mm → WARNING（薄壁）
 *  DFM-0105 口袋/槽内角为 0（无圆角）→ WARNING
 *  DFM-0106 存在倒扣面（法向朝下且非零件底面）→ BLOCKER
 *  DFM-0107 特征无可访问方向 → BLOCKER
 */
import type { FeatureGraph, Feature } from "@ai-cam/domain-schemas";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";

import type { DfmItem, DfmReport } from "./report.js";

export const RULES_VERSION = "0.1.0";

export interface DfmOptions {
  /** 最小刀具直径（mm），默认 Ø6 */
  minToolDiameterMm?: number;
  /** 深腔警示比，默认 3 */
  deepPocketWarnRatio?: number;
  /** 深腔阻断比，默认 5 */
  deepPocketBlockRatio?: number;
  /** 深孔警示比，默认 5 */
  deepHoleWarnRatio?: number;
  /** 深孔阻断比，默认 8 */
  deepHoleBlockRatio?: number;
  /** 最小壁厚（mm），默认 2 */
  minWallMm?: number;
}

export const DEFAULT_DFM_OPTIONS: Required<DfmOptions> = {
  minToolDiameterMm: 6,
  deepPocketWarnRatio: 3,
  deepPocketBlockRatio: 5,
  deepHoleWarnRatio: 5,
  deepHoleBlockRatio: 8,
  minWallMm: 2,
};

const POCKET_TYPES = new Set(["POCKET", "OPEN_POCKET", "SLOT"]);

/**
 * 倒扣面判定阈值（DFM-0106，默认值保持 120° 不变）：
 * 面法向与 +Z 轴夹角超过此角度（度）即视为倒扣面。
 * 120° ⇔ 法向 Z 分量 < cos(120°) ≈ -0.5（法向朝下倾斜超过 30°）。
 */
export const OVERHANG_ANGLE_DEG = 120;

/** 由 OVERHANG_ANGLE_DEG 导出的法向 Z 分量下界 */
const overhangNormalZ = Math.cos((OVERHANG_ANGLE_DEG * Math.PI) / 180);

interface Evidence {
  feature_ids?: string[];
  details?: Record<string, number>;
}

export function analyzeDfm(
  part: NormalizedPartModel,
  graph: FeatureGraph,
  options: DfmOptions = {},
): DfmReport {
  const o = { ...DEFAULT_DFM_OPTIONS, ...options };
  const items: DfmItem[] = [];
  let seq = 0;
  const push = (severity: DfmItem["severity"], code: string, message: string, ev: Evidence = {}) => {
    seq += 1;
    items.push({ id: `D${String(seq).padStart(4, "0")}`, severity, code, message, feature_ids: ev.feature_ids ?? [], details: ev.details });
  };

  const features = graph.features;
  const partBox = part.bbox_mm;

  for (const f of features) {
    const dims = f.dimensions ?? {};
    const minDim = Math.min(...Object.values(dims).filter((v) => v > 0));

    // DFM-0101 最小特征尺寸
    if (minDim > 0 && minDim < o.minToolDiameterMm) {
      push("INFO", "DFM-0101", `特征 ${f.id}（${f.type}）最小尺寸 ${fmt(minDim)}mm 小于默认刀具直径 Ø${o.minToolDiameterMm}mm`, {
        feature_ids: [f.id],
        details: { min_dimension_mm: minDim, tool_diameter_mm: o.minToolDiameterMm },
      });
    }

    // DFM-0102 深腔
    if (POCKET_TYPES.has(f.type) && dims.depth_mm && dims.width_mm) {
      const ratio = dims.depth_mm / dims.width_mm;
      if (ratio > o.deepPocketBlockRatio) {
        push("BLOCKER", "DFM-0102", `特征 ${f.id}（${f.type}）深宽比 ${fmt(ratio)} 超出可加工范围（>${o.deepPocketBlockRatio}）`, {
          feature_ids: [f.id],
          details: { depth_mm: dims.depth_mm, width_mm: dims.width_mm, ratio },
        });
      } else if (ratio > o.deepPocketWarnRatio) {
        push("WARNING", "DFM-0102", `特征 ${f.id}（${f.type}）深宽比 ${fmt(ratio)} 偏深（>${o.deepPocketWarnRatio}），需加长刀具/分层加工`, {
          feature_ids: [f.id],
          details: { depth_mm: dims.depth_mm, width_mm: dims.width_mm, ratio },
        });
      }
    }

    // DFM-0103 深孔
    if ((f.type === "HOLE_THROUGH" || f.type === "HOLE_BLIND") && dims.depth_mm && dims.diameter_mm) {
      const ratio = dims.depth_mm / dims.diameter_mm;
      if (ratio > o.deepHoleBlockRatio) {
        push("BLOCKER", "DFM-0103", `特征 ${f.id}（${f.type}）深径比 ${fmt(ratio)} 超出标准钻头能力（>${o.deepHoleBlockRatio}）`, {
          feature_ids: [f.id],
          details: { depth_mm: dims.depth_mm, diameter_mm: dims.diameter_mm, ratio },
        });
      } else if (ratio > o.deepHoleWarnRatio) {
        push("WARNING", "DFM-0103", `特征 ${f.id}（${f.type}）深径比 ${fmt(ratio)} 偏深（>${o.deepHoleWarnRatio}），建议啄钻或定制刀具`, {
          feature_ids: [f.id],
          details: { depth_mm: dims.depth_mm, diameter_mm: dims.diameter_mm, ratio },
        });
      }
    }

    // DFM-0104 薄壁（内部特征到零件边缘的距离）
    if (POCKET_TYPES.has(f.type) || f.type === "HOLE_THROUGH" || f.type === "HOLE_BLIND") {
      const wall = minEdgeDistance(f.bbox, partBox);
      if (wall < o.minWallMm) {
        push("WARNING", "DFM-0104", `特征 ${f.id}（${f.type}）距零件边缘仅 ${fmt(wall)}mm（<${o.minWallMm}mm），存在薄壁/断裂风险`, {
          feature_ids: [f.id],
          details: { min_wall_mm: wall, limit_mm: o.minWallMm },
        });
      }
    }

    // DFM-0105 尖锐内角
    if (POCKET_TYPES.has(f.type)) {
      const minR = cornerRadiusOf(f);
      if (minR != null && minR < 1e-6) {
        push("WARNING", "DFM-0105", `特征 ${f.id}（${f.type}）内角为尖角（无圆角），需 ≥ 刀具半径的圆角半径`, {
          feature_ids: [f.id],
          details: { corner_radius_mm: minR },
        });
      }
    }

    // DFM-0107 可访问性
    if (f.accessible_directions.length === 0) {
      push("BLOCKER", "DFM-0107", `特征 ${f.id}（${f.type}）无可访问方向，无法加工`, {
        feature_ids: [f.id],
      });
    }
  }

  // DFM-0106 倒扣面（零件级）
  for (const face of part.faces) {
    if (face.type === "PLANE" && face.normal && face.normal[2] < overhangNormalZ) {
      const isBottom = Math.abs(face.bbox.max[2] - partBox.min[2]) < 0.1;
      if (!isBottom) {
        push("BLOCKER", "DFM-0106", `存在倒扣面（面 #${face.id} 法向朝下且非底面），需特殊工装或 5 轴`, {
          details: { face_id: face.id, normal_z: face.normal[2] },
        });
        break;
      }
    }
  }

  type SummaryKeys = "info" | "warning" | "blocker";
  const summary: Record<SummaryKeys, number> = { info: 0, warning: 0, blocker: 0 };
  for (const it of items) {
    summary[it.severity.toLowerCase() as SummaryKeys] += 1;
  }

  return {
    part_id: graph.part_id,
    rules_version: RULES_VERSION,
    created_at: new Date().toISOString(),
    summary,
    items,
  };
}

function minEdgeDistance(
  fb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  pb: { min: [number, number, number]; max: [number, number, number] },
): number {
  const dx = Math.min(
    Math.abs(fb.min.x - pb.min[0]),
    Math.abs(fb.max.x - pb.max[0]),
  );
  const dy = Math.min(
    Math.abs(fb.min.y - pb.min[1]),
    Math.abs(fb.max.y - pb.max[1]),
  );
  return Math.min(dx, dy);
}

/**
 * 型腔/槽最小内圆角半径（mm）。
 * v1 Feature 仅携带 bbox + dimensions 数值字典，不含轮廓拓扑边；
 * 若识别器未在 dimensions 中给出内圆角半径，则视为 v1 几何无法解析，
 * 返回 null —— 报告层跳过 DFM-0105，避免对每个型腔误报尖角。
 */
const CORNER_RADIUS_KEYS = [
  "corner_radius_mm",
  "inner_corner_radius_mm",
  "fillet_radius_mm",
  "inner_radius_mm",
  "r_mm",
] as const;

function cornerRadiusOf(f: Feature): number | null {
  const dims = f.dimensions;
  if (!dims) return null;
  let min: number | null = null;
  for (const k of CORNER_RADIUS_KEYS) {
    const v = dims[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      min = min == null ? v : Math.min(min, v);
    }
  }
  return min;
}

function fmt(v: number): string {
  return Number(v.toFixed(2)).toString();
}
