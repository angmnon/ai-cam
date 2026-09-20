/** 三维向量工具（元组 [x,y,z]，与 worker 输出一致） */
export type V3 = [number, number, number];

export const TOL = 1e-6;

export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm(a: V3): number {
  return Math.sqrt(dot(a, a));
}

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function approx(a: number, b: number, tol = TOL): boolean {
  return Math.abs(a - b) <= tol;
}

export function approxVec(a: V3, b: V3, tol = 1e-3): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

export const Z_POS: V3 = [0, 0, 1];
export const Z_NEG: V3 = [0, 0, -1];

export interface Box3 {
  min: V3;
  max: V3;
}

export function boxSize(b: Box3): V3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function boxCenter(b: Box3): V3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

/** 面/特征包围盒是否触及零件包围盒的某条边（用于判断开放方向） */
export function openSides(fb: Box3, pb: Box3, tol = 0.15): Array<"+X" | "-X" | "+Y" | "-Y"> {
  const dirs: Array<"+X" | "-X" | "+Y" | "-Y"> = [];
  if (Math.abs(fb.min[0] - pb.min[0]) <= tol) dirs.push("-X");
  if (Math.abs(fb.max[0] - pb.max[0]) <= tol) dirs.push("+X");
  if (Math.abs(fb.min[1] - pb.min[1]) <= tol) dirs.push("-Y");
  if (Math.abs(fb.max[1] - pb.max[1]) <= tol) dirs.push("+Y");
  return dirs;
}

/** XY 投影面积 */
export function xyArea(b: Box3): number {
  return (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]);
}
