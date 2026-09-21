/**
 * Linking / 进退刀模块（P2-7）：安全平面、快速定位、垂直下刀、螺旋下刀、斜坡进刀、退刀。
 * 所有 move 为确定性输出，feed 单位 mm/min。
 */
import type { ToolpathMove, ToolpathMoveType } from "@ai-cam/cam-ir";

export interface MoveBuilder {
  moves: ToolpathMove[];
  add(type: ToolpathMoveType, x: number, y: number, z: number, feed?: number): void;
  linear(x: number, y: number, z: number, feed: number): void;
  rapid(x: number, y: number, z: number): void;
  plungeTo(z: number, feed: number, x?: number, y?: number): void;
  retractTo(z: number, feed: number, x?: number, y?: number): void;
}

export function createMoveBuilder(): MoveBuilder {
  const moves: ToolpathMove[] = [];
  const builder: MoveBuilder = {
    moves,
    add(type, x, y, z, feed) {
      const m: ToolpathMove = { type, x: round5(x), y: round5(y), z: round5(z) };
      if (feed != null) m.feed_mm_min = round5(feed);
      moves.push(m);
    },
    linear(x, y, z, feed) {
      this.add("LINEAR", x, y, z, feed);
    },
    rapid(x, y, z) {
      this.add("RAPID", x, y, z);
    },
    plungeTo(z, feed, x, y) {
      const last = this.moves[this.moves.length - 1];
      this.add("PLUNGE", x ?? last?.x ?? 0, y ?? last?.y ?? 0, z, feed);
    },
    retractTo(z, feed, x, y) {
      const last = this.moves[this.moves.length - 1];
      this.add("RETRACT", x ?? last?.x ?? 0, y ?? last?.y ?? 0, z, feed);
    },
  };
  return builder;
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** 安全平面快速定位 */
export function rapidToSafe(b: MoveBuilder, x: number, y: number, safeZ: number): void {
  b.rapid(x, y, safeZ);
}

/**
 * 螺旋下刀（helix entry）：以 (cx,cy) 为轴心，半径 helixR，从 zTop 螺旋下降
 * 到 zBottom，总圈数 turns。v1 用 LINEAR 微段线性逼近（每段 15°）。
 */
export function helixEntry(
  b: MoveBuilder,
  cx: number,
  cy: number,
  zTop: number,
  zBottom: number,
  helixR: number,
  feed: number,
  turns = 2,
): void {
  const segPerTurn = 24; // 每圈 24 段 = 15°
  const totalSeg = Math.max(1, Math.round(segPerTurn * turns));
  const dz = (zBottom - zTop) / totalSeg;
  for (let i = 1; i <= totalSeg; i++) {
    const a = (i / segPerTurn) * Math.PI * 2;
    const x = cx + helixR * Math.cos(a);
    const y = cy + helixR * Math.sin(a);
    const z = zTop + dz * i;
    b.linear(x, y, z, feed);
  }
}

/**
 * 斜坡进刀（ramp entry，P3-11）：从当前点（进刀起点/安全面）按 rampAngleDeg
 * 斜切到层深 (x1,y1,z1)。
 *
 * rampAngleDeg：刀具路径与水平面的夹角（度）。切入斜率 = tan(θ)（垂直降 / 水平走）。
 * 由 z0→z1 的总降深 dz 反推水平 ramp 长度 rampLen = dz / tan(θ)，沿当前点指向
 * (x1,y1) 的方向以分段 LINEAR 微段逼近该斜线（每段垂直下降 ≤ rampStepDownMm）。
 * 若水平可用距离 avail < rampLen，按可用距离成角（弦比 θ 陡，属余量不足兜底）；
 * 若 avail ≥ rampLen，到达层深后补一段水平到 (x1,y1)。
 * rampAngleDeg ≤ 0 或无降深/无水平位移：退化为单段 LINEAR（保持旧行为，向后兼容）。
 */
export function rampEntry(
  b: MoveBuilder,
  x1: number,
  y1: number,
  z1: number,
  feed: number,
  rampAngleDeg = 0,
  rampStepDownMm = 1,
): void {
  const last = b.moves[b.moves.length - 1];
  const x0 = last?.x ?? 0;
  const y0 = last?.y ?? 0;
  const z0 = last?.z ?? z1;
  const dz = z0 - z1; // 向下为正
  const dx = x1 - x0;
  const dy = y1 - y0;
  const avail = Math.hypot(dx, dy);

  // 无下刀量、无水平位移或未指定斜坡角：单段直线（旧行为）
  if (dz <= 1e-9 || avail < 1e-9 || rampAngleDeg <= 0) {
    b.linear(x1, y1, z1, feed);
    return;
  }

  const theta = (Math.min(89.9, Math.max(0.1, rampAngleDeg)) * Math.PI) / 180;
  const slope = Math.tan(theta); // 垂直降 / 水平走
  const rampLen = dz / slope; // 达到层深所需水平长度
  const reach = Math.min(rampLen, avail);
  const ux = dx / avail;
  const uy = dy / avail;

  // 分段：每段垂直下降 ≤ rampStepDownMm，至少 1 段
  const nSeg = Math.max(1, Math.ceil(dz / Math.max(1e-6, rampStepDownMm)));
  const segDz = dz / nSeg;
  const segHoriz = segDz / slope;
  for (let i = 1; i <= nSeg; i++) {
    const horiz = Math.min(i * segHoriz, reach);
    b.linear(x0 + ux * horiz, y0 + uy * horiz, z0 - i * segDz, feed);
  }
  // 水平可用距离足够：已到层深但未到 (x1,y1)，补一段水平切削到目标点
  if (reach < avail - 1e-9) {
    b.linear(x1, y1, z1, feed);
  }
}

/** 退刀到安全平面（垂直） */
export function retractToSafe(b: MoveBuilder, safeZ: number, feed: number): void {
  b.retractTo(safeZ, feed);
}
