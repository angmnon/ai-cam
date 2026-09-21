/**
 * 2D 几何工具（P2-1）：轴对齐矩形轮廓 / 等距 / 行切 / 同心环 / 分层 / 覆盖率。
 *
 * v1 确定性约束：所有刀路输入以特征 bbox（轴对齐矩形）为轮廓近似，
 * 非轴对齐轮廓由 Phase 3+ 的 geometry_worker 轮廓折线输出补齐。
 * 单位：mm。
 */

export interface Rect2D {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Line2D {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const rect2 = (x0: number, y0: number, x1: number, y1: number): Rect2D => ({
  x0: Math.min(x0, x1),
  y0: Math.min(y0, y1),
  x1: Math.max(x0, x1),
  y1: Math.max(y0, y1),
});

export const rectFromBBox = (min: number[], max: number[]): Rect2D => rect2(min[0], min[1], max[0], max[1]);

export const rectArea = (r: Rect2D): number => Math.max(0, (r.x1 - r.x0) * (r.y1 - r.y0));

export const rectCenter = (r: Rect2D): { x: number; y: number } => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

export const rectWidth = (r: Rect2D): number => r.x1 - r.x0;
export const rectHeight = (r: Rect2D): number => r.y1 - r.y0;

/** 收缩矩形；amount 超过半宽时返回 null */
export function insetRect(r: Rect2D, amount: number): Rect2D | null {
  const halfW = (r.x1 - r.x0) / 2;
  const halfH = (r.y1 - r.y0) / 2;
  if (amount >= halfW || amount >= halfH) return null;
  return { x0: r.x0 + amount, y0: r.y0 + amount, x1: r.x1 - amount, y1: r.y1 - amount };
}

/** 外扩矩形 */
export function growRect(r: Rect2D, amount: number): Rect2D {
  return { x0: r.x0 - amount, y0: r.y0 - amount, x1: r.x1 + amount, y1: r.y1 + amount };
}

/** 水平行切直线族（从 startY 起、步进 step，覆盖 [y0,y1]） */
export function horizontalLines(r: Rect2D, step: number): Line2D[] {
  const lines: Line2D[] = [];
  if (step <= 0 || r.y1 - r.y0 < 1e-9) return lines;
  for (let y = r.y0; y <= r.y1 + 1e-9; y += step) {
    lines.push({ x0: r.x0, y0: y, x1: r.x1, y1: y });
  }
  return lines;
}

/** 垂直行切直线族 */
export function verticalLines(r: Rect2D, step: number): Line2D[] {
  const lines: Line2D[] = [];
  if (step <= 0 || r.x1 - r.x0 < 1e-9) return lines;
  for (let x = r.x0; x <= r.x1 + 1e-9; x += step) {
    lines.push({ x0: x, y0: r.y0, x1: x, y1: r.y1 });
  }
  return lines;
}

/**
 * 行切折线（zigzag）：把行切直线族串成单条连续折线。
 * 行进方向沿 x；相邻行通过行尾连接（Y 方向过渡）。
 */
export function zigzagChain(lines: Line2D[]): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  if (lines.length === 0) return pts;
  let forward = true;
  for (const ln of lines) {
    const [x0, y0, x1, y1] = forward ? [ln.x0, ln.y0, ln.x1, ln.y1] : [ln.x1, ln.y1, ln.x0, ln.y0];
    if (pts.length === 0) {
      pts.push([x0, y0]);
    } else {
      const [px, py] = pts[pts.length - 1];
      if (Math.abs(px - x0) > 1e-9 || Math.abs(py - y0) > 1e-9) pts.push([x0, y0]); // 行间过渡
    }
    pts.push([x1, y1]);
    forward = !forward;
  }
  return pts;
}

/**
 * 等距同心矩形环（从外向内），间距 stepover，直到最小边 ≤ 2×toolR 停止。
 * 用于 Pocket 环切 / Adaptive 等距粗加工近似。
 */
export function concentricRects(outer: Rect2D, toolR: number, stepover: number): Rect2D[] {
  const rings: Rect2D[] = [];
  let cur = outer;
  const minExtent = 2 * toolR;
  let guard = 0;
  while (rectWidth(cur) > minExtent && rectHeight(cur) > minExtent && guard < 200) {
    rings.push(cur);
    const next = insetRect(cur, stepover);
    if (!next) break;
    cur = next;
    guard++;
  }
  // 决策（P3-12）：v1 不补残余中心中心线。残余中心为边长 ≤ 2×toolR 的小矩形，
  // 单条中心直线会新增刀路段并改变 pocket golden 输出；该残留留待 Phase 3+ 的
  // adaptive 环切/螺旋中心策略统一处理。此处固化决策、不实现，避免悬挂 TODO。
  return rings;
}

/** 分层：从 topZ 向下按 stepdown 切到 bottomZ，返回每层切削深度 z（含 bottomZ 最后一层） */
export function splitLayers(topZ: number, bottomZ: number, stepdown: number): number[] {
  if (stepdown <= 0 || bottomZ > topZ) return [];
  const layers: number[] = [];
  let z = topZ;
  while (z > bottomZ + 1e-9) {
    layers.push(z);
    z -= stepdown;
  }
  if (layers.length === 0 || Math.abs(layers[layers.length - 1] - bottomZ) > 1e-9) layers.push(bottomZ);
  return layers;
}

/** 覆盖估算：行切在区域内扫过的面积 / 区域面积（用于 Face/Pocket 覆盖阈值断言） */
export function coverageRatio(region: Rect2D, lines: Line2D[], toolR: number): number {
  const area = rectArea(region);
  if (area <= 1e-9 || lines.length === 0) return 0;
  // 每条行切覆盖宽度 2×toolR 的条带（半带在区域外也无妨——按重叠条带面积计）
  let covered = 0;
  const step = lines.length > 1 ? Math.abs(lines[1].y0 - lines[0].y0) : 2 * toolR;
  for (const ln of lines) {
    const inRegion = Math.min(ln.x1, region.x1) - Math.max(ln.x0, region.x0);
    covered += Math.max(0, inRegion) * Math.min(2 * toolR, step);
  }
  return Math.min(1, covered / area);
}
