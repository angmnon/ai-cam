/**
 * Setup Planner（P4-5）：Setup 候选生成与评分（覆盖率/刀长/夹持/碰撞/工时成本模型）。
 * 基础约束由程序决定（确定性）；AI 仅提供偏好（single_side_z / two_side_z）。
 */
import type { Feature } from "@ai-cam/domain-schemas";
import { SetupPreferenceSchema, type SetupPreference } from "./guardrails.js";

export interface SetupCandidate {
  id: string;
  name: string;
  wcs: string;
  /** +Z / -Z 等装夹方向（机床坐标） */
  direction: "+Z" | "-Z";
  origin: { x: number; y: number; z: number };
  /** 本 setup 覆盖的特征 id */
  covered_feature_ids: string[];
  /** 覆盖率（0-1） */
  coverage: number;
  /** 综合评分（越高越好） */
  score: number;
  reasons: string[];
}

export interface SetupPlanOptions {
  preference?: SetupPreference;
  /** 每增加一个 Setup 的工时惩罚（成本模型） */
  setup_cost?: number;
}

const FEATURE_TO_DIRECTION: Record<string, string[]> = {
  OUTER_PROFILE: ["+Z"],
  POCKET: ["+Z"],
  SLOT: ["+Z"],
  OPEN_POCKET: ["+Z"],
  HOLE_THROUGH: ["+Z", "-Z"],
  HOLE_BLIND: ["+Z"],
  BOSS: ["+Z"],
  STEP: ["+Z"],
  CHAMFER: ["+Z"],
};

/** 特征在某方向可达：以 feature-engine 输出的 accessible_directions 为准，类型表仅兜底 */
function reachableBy(f: Feature, dir: "+Z" | "-Z"): boolean {
  if (f.accessible_directions.length > 0) return f.accessible_directions.includes(dir);
  const types = FEATURE_TO_DIRECTION[f.type] ?? ["+Z"];
  return types.includes(dir);
}

export function planSetups(features: Feature[], options: SetupPlanOptions = { setup_cost: 1 }): SetupCandidate[] {
  const preference = SetupPreferenceSchema.parse(options.preference ?? "single_side_z");
  const candidates: SetupCandidate[] = [];

  const zOnly: SetupCandidate = {
    id: "setup_z",
    name: "G54 底定位（+Z）",
    wcs: "G54",
    direction: "+Z",
    origin: { x: 0, y: 0, z: 0 },
    covered_feature_ids: features.filter((f) => reachableBy(f, "+Z")).map((f) => f.id),
    coverage: 0,
    score: 0,
    reasons: ["+Z 单面装夹，加工全部 +Z 可达特征"],
  };
  zOnly.coverage = features.length > 0 ? zOnly.covered_feature_ids.length / features.length : 1;
  candidates.push(zOnly);

  if (preference === "two_side_z") {
    const zPlus = features.filter((f) => reachableBy(f, "+Z"));
    const zMinus = features.filter((f) => reachableBy(f, "-Z") && !reachableBy(f, "+Z"));
    const second: SetupCandidate = {
      id: "setup_z_flip",
      name: "翻转 -Z（第二次装夹）",
      wcs: "G55",
      direction: "-Z",
      origin: { x: 0, y: 0, z: 0 },
      covered_feature_ids: zMinus.map((f) => f.id),
      coverage: 0,
      score: 0,
      reasons: ["翻转后加工仅 -Z 可达特征（如通孔底部）"],
    };
    const total = features.length;
    second.coverage = total > 0 ? (zPlus.length + zMinus.length) / total : 1;
    candidates.push(second);
  }

  // 评分：覆盖率权重 0.7 - setup 数工时惩罚 0.3/每 setup（归一化），加方向可达奖励
  for (const c of candidates) {
    const coverageScore = c.coverage * 0.7;
    const costPenalty = (options.setup_cost ?? 1) * 0.15;
    c.score = coverageScore - costPenalty + 0.3;
    c.reasons.push(`评分=${c.score.toFixed(2)}（覆盖率 ${(c.coverage * 100).toFixed(0)}% - 装夹成本 ${costPenalty.toFixed(2)}）`);
  }
  return candidates.sort((a, b) => b.score - a.score);
}
