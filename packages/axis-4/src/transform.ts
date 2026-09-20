/**
 * Indexed 4 轴坐标变换（P5-1）：工件绕 A（绕 X）或 B（绕 Y）轴旋转的刚体变换。
 * 约定：角度单位度，右手系；A 轴旋转后 +Z 工具方向指向原方向，用于把"侧向/背面"特征转到可加工方向。
 */
export type IndexAxis = "A" | "B";

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** 绕 A 轴（绕 X）旋转 θ：y'=y·cosθ−z·sinθ, z'=y·sinθ+z·cosθ */
export function transformPoint(p: Point3, axis: IndexAxis, angle: number): Point3 {
  const c = Math.cos(rad(angle));
  const s = Math.sin(rad(angle));
  if (axis === "A") {
    return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c };
  }
  // B 轴（绕 Y）：x'=x·cosθ+z·sinθ, z'=−x·sinθ+z·cosθ
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

export function invertPoint(p: Point3, axis: IndexAxis, angle: number): Point3 {
  return transformPoint(p, axis, -angle);
}

export interface BBox3 {
  min: Point3;
  max: Point3;
}

export function transformBBox(b: BBox3, axis: IndexAxis, angle: number): BBox3 {
  const corners: Point3[] = [
    { x: b.min.x, y: b.min.y, z: b.min.z },
    { x: b.max.x, y: b.min.y, z: b.min.z },
    { x: b.min.x, y: b.max.y, z: b.min.z },
    { x: b.min.x, y: b.min.y, z: b.max.z },
    { x: b.max.x, y: b.max.y, z: b.min.z },
    { x: b.max.x, y: b.min.y, z: b.max.z },
    { x: b.min.x, y: b.max.y, z: b.max.z },
    { x: b.max.x, y: b.max.y, z: b.max.z },
  ].map((c) => transformPoint(c, axis, angle));
  return {
    min: { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)), z: Math.min(...corners.map((c) => c.z)) },
    max: { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)), z: Math.max(...corners.map((c) => c.z)) },
  };
}

/** 旋转后 +Z（工具方向）指向的原方向：A 轴 θ=0:+Z, 90:-Y, 180:-Z, 270:+Y；B 轴 θ=90:+X, 180:-Z, 270:-X */
export function rotatedPlusZ(axis: IndexAxis, angle: number): string {
  const dir = transformPoint({ x: 0, y: 0, z: 1 }, axis, angle);
  const pick = (v: number, neg: string, pos: string) => (Math.abs(v) < 1e-9 ? "" : v > 0 ? pos : neg);
  const ax = pick(dir.x, "-X", "+X");
  const ay = pick(dir.y, "-Y", "+Y");
  const az = pick(dir.z, "-Z", "+Z");
  return (ax || ay || az) || "+Z";
}
