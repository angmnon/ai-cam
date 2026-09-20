/**
 * Indexed 4 轴特征分配（P5-1）：把特征按可访问方向分配到各旋转角度 Setup，并做旋转限制检查。
 */
import type { Feature } from "@ai-cam/domain-schemas";
import { rotatedPlusZ, transformBBox, type IndexAxis, type BBox3 } from "./transform.js";

export interface RotationSetupSpec {
  /** 装夹角度（度），0 = 原始 3 轴方向 */
  angle: number;
  /** 该角度下 +Z 工具方向对应的原零件方向 */
  plus_z_dir: string;
  axis: IndexAxis;
}

export function defaultIndexAngles(): number[] {
  return [0, 90, 180, 270];
}

export function makeSetupSpecs(axis: IndexAxis, angles: number[]): RotationSetupSpec[] {
  return angles.map((angle) => ({ angle, plus_z_dir: rotatedPlusZ(axis, angle), axis }));
}

export interface FeatureAssignment {
  feature_id: string;
  /** 主分配角度（首个可访问匹配）；可多角度加工的特征记录全部匹配 */
  angle: number;
  all_angles: number[];
}

export interface RotateGuardViolation {
  path: string;
  message: string;
}

export interface RotateGuardResult {
  ok: boolean;
  violations: RotateGuardViolation[];
}

export function assignFeaturesToSetups(
  features: Feature[],
  axis: IndexAxis,
  angles: number[],
): { assignments: FeatureAssignment[]; guard: RotateGuardResult } {
  const specs = makeSetupSpecs(axis, angles);
  const valid = new Set(angles);
  const assignments: FeatureAssignment[] = [];
  const violations: RotateGuardViolation[] = [];
  for (const f of features) {
    const dirs = (f.accessible_directions ?? []).length > 0 ? f.accessible_directions : ["+Z"];
    const matches = specs.filter((s) => dirs.includes(s.plus_z_dir as never));
    if (matches.length === 0) {
      violations.push({ path: f.id, message: `特征 ${f.id}(${f.type}) 的可访问方向 [${dirs.join(",")}] 与任何旋转角度都不匹配` });
      continue;
    }
    assignments.push({ feature_id: f.id, angle: matches[0].angle, all_angles: matches.map((m) => m.angle) });
  }
  // 角度合法性（调用方给定之外的角度不可能出现，但防误用）
  for (const a of angles) if (!valid.has(a)) violations.push({ path: "angles", message: `非法旋转角度 ${a}` });
  return { assignments, guard: { ok: violations.length === 0, violations } };
}

export interface RotateGuardOptions {
  /** 机床行程（mm），传入则检查变换后包围盒，否则跳过（标 INFO） */
  machineTravel?: { x: number; y: number; z: number };
}

export function rotateGuard(
  features: Feature[],
  assignments: FeatureAssignment[],
  axis: IndexAxis,
  angles: number[],
  opts: RotateGuardOptions = {},
): RotateGuardResult {
  const { guard } = assignFeaturesToSetups(features, axis, angles);
  const violations = [...guard.violations];
  if (!opts.machineTravel) {
    violations.push({ path: "travel", message: "未配置机床行程（machineTravel），行程检查跳过（INFO）" });
    return { ok: false, violations };
  }
  for (const f of features) {
    const as = assignments.find((a) => a.feature_id === f.id);
    if (!as) continue;
    const bbox: BBox3 = {
      min: { x: f.bbox.min.x, y: f.bbox.min.y, z: f.bbox.min.z },
      max: { x: f.bbox.max.x, y: f.bbox.max.y, z: f.bbox.max.z },
    };
    const t = transformBBox(bbox, axis, as.angle);
    if (t.max.x > opts.machineTravel.x || t.max.y > opts.machineTravel.y || t.max.z > opts.machineTravel.z || t.min.x < 0 || t.min.y < 0 || t.min.z < 0) {
      violations.push({ path: f.id, message: `特征 ${f.id} 在角度 ${as.angle}° 变换后超出行程 [${t.min.x.toFixed(1)},${t.min.y.toFixed(1)},${t.min.z.toFixed(1)}]..[${t.max.x.toFixed(1)},${t.max.y.toFixed(1)},${t.max.z.toFixed(1)}]` });
    }
  }
  return { ok: violations.length === 0, violations };
}
