/**
 * 刀路生成器（P2-2 ~ P2-6）：Face / Pocket / Profile / Drill / Adaptive。
 * 所有函数确定性输出 ToolpathMove[]；进刀/退刀统一走 linking 模块。
 */
import type { ToolpathMove } from "@ai-cam/cam-ir";
import type { AccessDir } from "@ai-cam/feature-engine";
import { concentricRects, coverageRatio, horizontalLines, insetRect, rect2, splitLayers, zigzagChain, type Rect2D } from "../geometry2d.js";
import { createMoveBuilder, helixEntry, rapidToSafe, retractToSafe } from "../linking.js";

export interface OpBase {
  safeZ: number;
  feed: number;
  plungeFeed: number;
  toolR: number;
}

// ---------- P2-2 Face ----------
export interface FaceInput extends OpBase {
  /** 加工区域（stock 顶面，含 margin） */
  region: Rect2D;
  /** 切削深度 z（顶面清 0.05 面） */
  zCut: number;
  stepover: number;
}

export function faceOp(input: FaceInput): ToolpathMove[] {
  const b = createMoveBuilder();
  const { region, zCut, stepover, toolR, feed, plungeFeed, safeZ } = input;
  const lines = horizontalLines(region, stepover);
  const chain = zigzagChain(lines);
  if (chain.length === 0) return b.moves;

  // 进刀在区域外（左侧 toolR 外）
  const [sx, sy] = chain[0];
  rapidToSafe(b, sx - toolR - 1, sy, safeZ);
  b.plungeTo(zCut, plungeFeed);
  b.linear(sx, sy, zCut, feed);
  for (let i = 1; i < chain.length; i++) {
    const [px, py] = chain[i];
    b.linear(px, py, zCut, feed);
  }
  retractToSafe(b, safeZ, feed);
  return b.moves;
}

// ---------- P2-3 Pocket（闭/开、层切、螺旋进刀） ----------
export interface PocketInput extends OpBase {
  /** 特征区域（xy 轮廓近似） */
  region: Rect2D;
  zTop: number;
  zBottom: number;
  stepdown: number;
  stepover: number;
  /** 开放侧（SLOT/OPEN_POCKET）；闭腔为空数组 */
  openSides?: AccessDir[];
}

export function pocketOp(input: PocketInput): ToolpathMove[] {
  const b = createMoveBuilder();
  const { region, zTop, zBottom, stepdown, stepover, toolR, feed, plungeFeed, safeZ, openSides } = input;
  const layers = splitLayers(zTop, zBottom, stepdown);
  const cx = (region.x0 + region.x1) / 2;
  const cy = (region.y0 + region.y1) / 2;
  const isSlot = (openSides?.length ?? 0) >= 2;

  for (const z of layers) {
    if (isSlot) {
      // 贯通槽：沿长边中线一条（开放侧进刀）
      const midY = cy;
      rapidToSafe(b, region.x0 - toolR - 1, midY, safeZ);
      b.plungeTo(z, plungeFeed);
      b.linear(region.x1 + toolR + 1, midY, z, feed);
      retractToSafe(b, safeZ, feed);
      continue;
    }
    // 闭腔：中心垂直下刀到本层深度 → 水平旋入（避免首层从 safeZ 斜切全高 engagement）
    const helixR = Math.max(0.5 * toolR, Math.min(region.x1 - region.x0, region.y1 - region.y0) / 4);
    rapidToSafe(b, cx, cy, safeZ);
    b.plungeTo(z, plungeFeed, cx, cy); // 先垂直 plunge 到本层深度
    helixEntry(b, cx, cy, z, z, helixR, plungeFeed, 1); // 本层水平螺旋旋入
    const rings = concentricRects(region, toolR, stepover).reverse(); // 内→外
    for (const ring of rings) {
      const pts: Array<[number, number]> = [
        [ring.x0, ring.y0],
        [ring.x1, ring.y0],
        [ring.x1, ring.y1],
        [ring.x0, ring.y1],
        [ring.x0, ring.y0],
      ];
      for (const [px, py] of pts) {
        b.linear(px, py, z, feed);
      }
    }
    retractToSafe(b, safeZ, feed);
  }
  return b.moves;
}

// ---------- P2-4 Profile / Contour ----------
export interface ProfileInput extends OpBase {
  /** 轮廓矩形（特征/零件 xy） */
  rect: Rect2D;
  zTop: number;
  zBottom: number;
  stepdown: number;
  /** OUTER=外轮廓（刀心向外偏移）；INNER=内轮廓（刀心向内偏移） */
  side: "OUTER" | "INNER";
}

export function profileOp(input: ProfileInput): ToolpathMove[] {
  const b = createMoveBuilder();
  const { rect, zTop, zBottom, stepdown, toolR, feed, plungeFeed, safeZ, side } = input;
  const layers = splitLayers(zTop, zBottom, stepdown);
  const offsetRect: Rect2D =
    side === "OUTER"
      ? rect2(rect.x0 - toolR, rect.y0 - toolR, rect.x1 + toolR, rect.y1 + toolR)
      : (insetRect(rect, toolR) ?? rect);

  const pts: Array<[number, number]> = [
    [offsetRect.x0, offsetRect.y0],
    [offsetRect.x1, offsetRect.y0],
    [offsetRect.x1, offsetRect.y1],
    [offsetRect.x0, offsetRect.y1],
  ];

  for (const z of layers) {
    // 层间先抬刀再快速移动（Phase 3 仿真门禁：RAPID 不得穿越毛坯）
    if (b.moves.length > 0) retractToSafe(b, safeZ, feed);
    rapidToSafe(b, pts[0][0], pts[0][1], safeZ);
    b.plungeTo(z, plungeFeed);
    for (let i = 0; i < 5; i++) {
      const [px, py] = pts[i % 4];
      b.linear(px, py, z, feed);
    }
  }
  retractToSafe(b, safeZ, feed);
  return b.moves;
}

// ---------- P2-5 Drill ----------
export interface DrillHole {
  cx: number;
  cy: number;
  /** 钻孔深度（mm，已含过穿/留量语义由调用方计算） */
  depth: number;
  through: boolean;
}

export interface DrillInput extends OpBase {
  holes: DrillHole[];
  /** 点钻深度（v1=1mm） */
  spotDepth?: number;
  /** 啄钻单段深度（深径比 > 3 时启用） */
  peckStep?: number;
  zTop: number;
}

export function drillOp(input: DrillInput): ToolpathMove[] {
  const b = createMoveBuilder();
  const { holes, zTop, toolR, feed, plungeFeed, safeZ, spotDepth = 1, peckStep } = input;
  const depthRatio = (h: DrillHole) => h.depth / (2 * toolR);

  for (const h of holes) {
    const d = h.depth;
    // 点钻
    rapidToSafe(b, h.cx, h.cy, safeZ);
    b.plungeTo(zTop - Math.min(spotDepth, d), plungeFeed);
    retractToSafe(b, safeZ, feed);
    // 钻孔 / 啄钻
    rapidToSafe(b, h.cx, h.cy, safeZ);
    const usePeck = peckStep != null && depthRatio(h) > 3;
    if (!usePeck) {
      b.plungeTo(zTop - d, plungeFeed);
      retractToSafe(b, safeZ, feed);
    } else {
      let cur = spotDepth;
      while (cur < d) {
        const next = Math.min(d, cur + peckStep);
        b.plungeTo(zTop - next, plungeFeed);
        retractToSafe(b, safeZ, feed);
        cur = next;
      }
    }
  }
  return b.moves;
}

// ---------- P2-6 Adaptive v1（等距环切近似：恒定径向切宽） ----------
export interface AdaptiveInput extends OpBase {
  region: Rect2D;
  zTop: number;
  zBottom: number;
  stepdown: number;
  stepover: number;
}

export function adaptiveOp(input: AdaptiveInput): ToolpathMove[] {
  const b = createMoveBuilder();
  const { region, zTop, zBottom, stepdown, stepover, toolR, feed, plungeFeed, safeZ } = input;
  const layers = splitLayers(zTop, zBottom, stepdown);
  const cx = (region.x0 + region.x1) / 2;
  const cy = (region.y0 + region.y1) / 2;

  for (const z of layers) {
    const helixR = Math.max(0.5 * toolR, Math.min(region.x1 - region.x0, region.y1 - region.y0) / 4);
    rapidToSafe(b, cx, cy, safeZ);
    // 先垂直 plunge 到本层深度，再水平螺旋旋入（恒切宽进刀）
    b.plungeTo(z, plungeFeed, cx, cy);
    helixEntry(b, cx, cy, z, z, helixR, plungeFeed, 2);
    const rings = concentricRects(region, toolR, stepover).reverse();
    for (const ring of rings) {
      const pts: Array<[number, number]> = [
        [ring.x0, ring.y0],
        [ring.x1, ring.y0],
        [ring.x1, ring.y1],
        [ring.x0, ring.y1],
        [ring.x0, ring.y0],
      ];
      for (const [px, py] of pts) {
        b.linear(px, py, z, feed);
      }
    }
    retractToSafe(b, safeZ, feed);
  }
  return b.moves;
}

/** 行切覆盖率（供 Face/Pocket 覆盖阈值断言） */
export function faceCoverage(region: Rect2D, stepover: number, toolR: number): number {
  return coverageRatio(region, horizontalLines(region, stepover), toolR);
}
