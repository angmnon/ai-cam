/**
 * 特征识别 v1 — 确定性启发式识别器
 *
 * 输入：geometry_worker 输出的规范化零件模型（面/边/邻接）。
 * 识别顺序：孔（竖直圆柱）→ 凹面（口袋/槽底）→ 凸台 → 台阶 → 外轮廓。
 * 每个特征带 confidence、source_face_ids、可访问方向与尺寸，供 MFG Graph 与 DFM 消费。
 */
import type { BBoxArr, FaceInfo, NormalizedPartModel } from "@ai-cam/geometry-schema";

import { TOL, approx, boxSize, openSides, xyArea, type Box3 } from "./vec.js";

export type AccessDir = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

export type FeatureType =
  | "HOLE_THROUGH"
  | "HOLE_BLIND"
  | "POCKET"
  | "OPEN_POCKET"
  | "SLOT"
  | "BOSS"
  | "STEP"
  | "CHAMFER"
  | "OUTER_PROFILE"
  | "PLANAR_FACE";

export interface FeatureCandidate {
  id: string;
  type: FeatureType;
  confidence: number;
  source_face_ids: number[];
  bbox: Box3;
  accessible_directions: AccessDir[];
  dimensions: Record<string, number>;
}

export interface RecognizeOptions {
  /** 特征最小面积（mm²） */
  minArea?: number;
  /** 几何容差（mm） */
  tol?: number;
  /** 识别器版本 */
  recognizerVersion?: string;
}

export const DEFAULT_OPTIONS: Required<Pick<RecognizeOptions, "minArea" | "tol">> = {
  minArea: 5,
  tol: 0.15,
};

type FaceKind = "TOP" | "BOTTOM" | "SIDE" | "SLANT" | "VCYL" | "HCYL" | "OTHER";

function faceKind(face: FaceInfo): FaceKind {
  if (face.type === "CYLINDER") {
    if (face.axis && Math.abs(face.axis[2]) > 0.999) return "VCYL";
    return "HCYL";
  }
  if (face.type !== "PLANE" || !face.normal) return "OTHER";
  const nz = Math.abs(face.normal[2]);
  if (nz > 0.999) return face.normal[2] > 0 ? "TOP" : "BOTTOM";
  if (nz < 0.1) return "SIDE";
  return "SLANT";
}

function toBox3(b: BBoxArr): Box3 {
  return { min: [...b.min], max: [...b.max] };
}

function isPolygonal(face: FaceInfo): boolean {
  return face.edges.every((e) => e.type === "LINE");
}

export function recognize(part: NormalizedPartModel, options: RecognizeOptions = {}): FeatureCandidate[] {
  const minArea = options.minArea ?? DEFAULT_OPTIONS.minArea;
  const tol = options.tol ?? DEFAULT_OPTIONS.tol;

  const faces = part.faces;
  const partBox: Box3 = toBox3(part.bbox_mm);
  const zTop = partBox.max[2];
  const zBottom = partBox.min[2];

  const features: FeatureCandidate[] = [];
  const consumed = new Set<number>();
  const nextId = () => `F${String(features.length + 1).padStart(4, "0")}`;

  const byFace = new Map<number, FaceInfo>();
  for (const f of faces) byFace.set(f.id, f);
  const kindOf = (f: FaceInfo) => faceKind(f);

  // ---------- 1) 孔：竖直圆柱面 ----------
  for (const f of faces) {
    if (consumed.has(f.id)) continue;
    if (kindOf(f) !== "VCYL") continue;
    if (f.radius_mm == null || f.radius_mm < 0.5 || f.radius_mm > 50) continue;
    if (f.area_mm2 < minArea) continue;

    const spanMin = f.bbox.min[2];
    const spanMax = f.bbox.max[2];
    const depth = spanMax - spanMin;
    const touchesTop = approx(spanMax, zTop, tol);
    const touchesBottom = approx(spanMin, zBottom, tol);
    const through = touchesTop && touchesBottom;

    const cx = f.center[0];
    const cy = f.center[1];
    // 孔必须是零件内部的特征：外圆柱（零件侧壁）的 bbox 与零件 bbox 齐平，排除
    const insideX =
      cx - f.radius_mm > partBox.min[0] + tol * 2 && cx + f.radius_mm < partBox.max[0] - tol * 2;
    const insideY =
      cy - f.radius_mm > partBox.min[1] + tol * 2 && cy + f.radius_mm < partBox.max[1] - tol * 2;
    if (!insideX || !insideY) continue;
    const bbox: Box3 = {
      min: [cx - f.radius_mm, cy - f.radius_mm, spanMin],
      max: [cx + f.radius_mm, cy + f.radius_mm, spanMax],
    };
    features.push({
      id: nextId(),
      type: through ? "HOLE_THROUGH" : "HOLE_BLIND",
      confidence: 0.9,
      source_face_ids: [f.id],
      bbox,
      accessible_directions: through ? ["+Z", "-Z"] : ["+Z"],
      dimensions: { diameter_mm: f.radius_mm * 2, depth_mm: depth },
    });
    consumed.add(f.id);
    // 孔底圆面也归入该特征（若存在）
    for (const g of faces) {
      if (g.type === "PLANE" && g.normal && g.normal[2] > 0.999 && !consumed.has(g.id)) {
        const gz = g.bbox.max[2];
        if (approx(gz, spanMin, tol) && Math.abs(g.center[0] - cx) < tol && Math.abs(g.center[1] - cy) < tol) {
          consumed.add(g.id);
          features[features.length - 1].source_face_ids.push(g.id);
        }
      }
    }
  }

  // ---------- 2) 凹面（口袋/槽底） ----------
  const recessed = faces.filter((f) => {
    if (consumed.has(f.id)) return false;
    if (kindOf(f) !== "TOP") return false;
    if (f.area_mm2 < minArea) return false;
    if (!isPolygonal(f)) return false; // 排除圆孔底
    return f.bbox.max[2] < zTop - 0.05;
  });
  for (const bottom of recessed) {
    if (consumed.has(bottom.id)) continue;
    const zLevel = bottom.bbox.max[2];
    const depth = zTop - zLevel;
    // 匹配竖墙：墙底 ≈ 凹面高度，墙顶 ≈ 零件顶面
    const walls = faces.filter((w) => {
      if (consumed.has(w.id)) return false;
      if (kindOf(w) !== "SIDE") return false;
      return approx(w.bbox.min[2], zLevel, tol) && approx(w.bbox.max[2], zTop, tol);
    });
    const bottomBox = toBox3(bottom.bbox);
    const side = openSides(bottomBox, partBox, tol);
    const [lx, ly] = boxSize(bottomBox);
    const long = Math.max(lx, ly);
    const short = Math.min(lx, ly);
    const aspect = short > TOL ? long / short : 0;
    const closed = side.length === 0;
    // 整层平面（底 bbox 触及零件 bbox 全部 4 侧）：是台阶/外轮廓级别，不是凹槽
    if (side.length === 4) continue;

    let type: FeatureType;
    if (!closed && aspect > 2.5) type = "SLOT";
    else if (!closed) type = "OPEN_POCKET";
    else if (aspect > 2.5) type = "SLOT";
    else type = "POCKET";

    features.push({
      id: nextId(),
      type,
      confidence: 0.85,
      source_face_ids: [bottom.id, ...walls.map((w) => w.id)],
      bbox: bottomBox,
      accessible_directions: ["+Z", ...side],
      dimensions: { length_mm: long, width_mm: short, depth_mm: depth },
    });
    consumed.add(bottom.id);
    for (const w of walls) consumed.add(w.id);
  }

  // ---------- 3) 凸台（零件顶面的凸起，墙壁不落地） ----------
  const topFaces = faces.filter(
    (f) => !consumed.has(f.id) && kindOf(f) === "TOP" && approx(f.bbox.max[2], zTop, tol),
  );
  for (const top of topFaces) {
    if (consumed.has(top.id)) continue;
    if (top.area_mm2 < minArea) continue;
    if (!isPolygonal(top)) continue;
    const walls = faces.filter((w) => {
      if (consumed.has(w.id)) return false;
      if (kindOf(w) !== "SIDE") return false;
      return approx(w.bbox.max[2], zTop, tol) && w.bbox.min[2] > zBottom + 0.1;
    });
    if (walls.length === 0) continue;
    const wallMinZ = Math.min(...walls.map((w) => w.bbox.min[2]));
    const partXY = xyArea(partBox);
    const ratio = partXY > TOL ? xyArea(toBox3(top.bbox)) / partXY : 1;

    const topBox = toBox3(top.bbox);
    const [lx, ly] = boxSize(topBox);
    // 占零件投影面积 <30% 视为凸台，否则为顶部台阶
    const isBoss = ratio < 0.3;
    features.push({
      id: nextId(),
      type: isBoss ? "BOSS" : "STEP",
      confidence: isBoss ? 0.8 : 0.75,
      source_face_ids: [top.id, ...walls.map((w) => w.id)],
      bbox: topBox,
      accessible_directions: isBoss ? ["+Z", "+X", "-X", "+Y", "-Y"] : ["+Z"],
      dimensions: { length_mm: lx, width_mm: ly, height_mm: zTop - wallMinZ },
    });
    consumed.add(top.id);
    for (const w of walls) consumed.add(w.id);
  }

  // ---------- 4) 外轮廓（剩余最大顶面，任意层高；整层台阶/基座主面） ----------
  const remainingTop = faces.filter((f) => !consumed.has(f.id) && kindOf(f) === "TOP" && f.area_mm2 >= 50);
  remainingTop.sort((a, b) => b.area_mm2 - a.area_mm2);
  for (const f of remainingTop) {
    if (consumed.has(f.id)) continue;
    const fb = toBox3(f.bbox);
    const [lx, ly] = boxSize(fb);
    features.push({
      id: nextId(),
      type: "OUTER_PROFILE",
      confidence: 0.7,
      source_face_ids: [f.id],
      bbox: fb,
      accessible_directions: ["+Z"],
      dimensions: { length_mm: lx, width_mm: ly },
    });
    consumed.add(f.id);
  }

  // ---------- 5) 台阶（中间高度的大平面，未被消费时补充） ----------
  const mid = faces.filter(
    (f) =>
      !consumed.has(f.id) &&
      kindOf(f) === "TOP" &&
      f.area_mm2 >= 50 &&
      isPolygonal(f) &&
      f.bbox.max[2] > zBottom + 0.1 &&
      f.bbox.max[2] < zTop - 0.05,
  );
  for (const f of mid) {
    if (consumed.has(f.id)) continue;
    const fb = toBox3(f.bbox);
    const [lx, ly] = boxSize(fb);
    features.push({
      id: nextId(),
      type: "STEP",
      confidence: 0.75,
      source_face_ids: [f.id],
      bbox: fb,
      accessible_directions: ["+Z"],
      dimensions: { length_mm: lx, width_mm: ly, height_mm: zTop - f.bbox.max[2] },
    });
    consumed.add(f.id);
  }

  // ---------- 6) 斜角/残留平面 ----------
  for (const f of faces) {
    if (consumed.has(f.id)) continue;
    if (kindOf(f) === "SLANT" && f.area_mm2 >= minArea) {
      const nz = f.normal ? Math.abs(f.normal[2]) : 0;
      const isChamfer = nz >= 0.35 && nz <= 0.94;
      const fb = toBox3(f.bbox);
      const [lx, ly] = boxSize(fb);
      features.push({
        id: nextId(),
        type: isChamfer ? "CHAMFER" : "PLANAR_FACE",
        confidence: 0.6,
        source_face_ids: [f.id],
        bbox: fb,
        accessible_directions: ["+Z"],
        dimensions: { length_mm: lx, width_mm: ly },
      });
      consumed.add(f.id);
    }
  }

  features.sort((a, b) => a.id.localeCompare(b.id));
  return features;
}

export function featureBoxToArr(b: Box3): BBoxArr {
  return { min: [...b.min], max: [...b.max] };
}

export function featureTypeOf(t: FeatureType): string {
  return t;
}
