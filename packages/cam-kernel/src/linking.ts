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

/** 斜坡进刀（ramp entry）：从当前点线性斜切到目标深度 */
export function rampEntry(b: MoveBuilder, x1: number, y1: number, z1: number, feed: number): void {
  void b;
  b.linear(x1, y1, z1, feed);
}

/** 退刀到安全平面（垂直） */
export function retractToSafe(b: MoveBuilder, safeZ: number, feed: number): void {
  b.retractTo(safeZ, feed);
}
