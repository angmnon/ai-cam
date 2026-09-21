/**
 * Fixture Planner v1（P5-2）：3-2-1 定位 + 候选装夹 + 夹具碰撞检查。
 *
 * 3-2-1 定位原理：
 * - 主基准（Primary）：底面 −Z，3 个支撑点（三角形分布）限制 Z 平移 + X/Y 旋转；
 * - 导向基准（Secondary）：侧面 +X，2 个定位销/挡块限制 Y 平移 + Z 旋转；
 * - 止动基准（Tertiary）：端面 −Y，1 个挡块限制 X 平移。
 * 夹持力方向与定位方向相反（Z− 支撑、X− 侧压），构成稳定静定装夹。
 */
import type { BBox } from "@ai-cam/domain-schemas";

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface LocatorPoint extends Point3 {
  kind: "PRIMARY" | "SECONDARY" | "TERTIARY";
  label: string;
}

export interface LocatePlan {
  /** 主基准面（底面法向，3 轴为 −Z） */
  primary_face_normal: string;
  locators: LocatorPoint[];
  /** 静定约束数：3-2-1 = 6 */
  constraint_count: number;
}

export interface FixtureCandidate {
  id: string;
  type: "VISE" | "SOFT_JAW" | "CUSTOM";
  /** 夹持面法向（夹具施加夹紧力的方向） */
  clamp_dir: string;
  /** 夹持位置（装夹点/接触带） */
  contact: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  /** 夹具本体包络（固定部分，用于碰撞检查） */
  body: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  /** 与定位计划的配合说明 */
  rationale: string[];
}

export interface FixturePlan {
  locate: LocatePlan;
  candidates: FixtureCandidate[];
  recommended_id: string;
  /** P3-28：决策 WARN 记录（如 soft_jaw 请求但被静默回退为 VISE） */
  warnings: string[];
}

export function planLocators(bbox: BBox, marginMm = 10): LocatePlan {
  const { min, max } = bbox;
  const cx = (min.x + max.x) / 2;
  const cy = (min.y + max.y) / 2;
  const x0 = min.x + marginMm;
  const x1 = max.x - marginMm;
  const y0 = min.y + marginMm;
  const y1 = max.y - marginMm;
  const z0 = min.z;
  // 主基准 3 点：底面三角形（后-前-后分布，避免共线）
  const primary: LocatorPoint[] = [
    { x: x0, y: y1, z: z0, kind: "PRIMARY", label: "P1 底-后左" },
    { x: x1, y: y1, z: z0, kind: "PRIMARY", label: "P2 底-后右" },
    { x: cx, y: y0, z: z0, kind: "PRIMARY", label: "P3 底-前中" },
  ];
  // 导向基准 2 点：+X 侧面（限制 Y/Z 旋转）
  const secondary: LocatorPoint[] = [
    { x: max.x, y: cy - marginMm, z: (min.z + max.z) / 2, kind: "SECONDARY", label: "S1 侧-X向" },
    { x: max.x, y: cy + marginMm, z: (min.z + max.z) / 2, kind: "SECONDARY", label: "S2 侧+X向" },
  ];
  // 止动基准 1 点：−Y 端面
  const tertiary: LocatorPoint[] = [{ x: cx, y: min.y, z: (min.z + max.z) / 2, kind: "TERTIARY", label: "T1 端-Y向" }];
  return {
    primary_face_normal: "-Z",
    locators: [...primary, ...secondary, ...tertiary],
    constraint_count: 6,
  };
}

export interface FixtureOptions {
  /** 夹持方向："X" | "Y"（默认 X，绕 Z 侧夹） */
  clamp_axis?: "X" | "Y";
  /** 夹持深度（沿夹持方向的接触宽度，mm） */
  clamp_depth_mm?: number;
  /** 软爪爪体延伸（超出零件顶面的高度，mm） */
  jaw_overhang_mm?: number;
  /** 是否生成软爪候选 */
  soft_jaw?: boolean;
}

export function candidateFixtures(bbox: BBox, opts: FixtureOptions = {}): FixtureCandidate[] {
  const { min, max } = bbox;
  const clampDepth = opts.clamp_depth_mm ?? 15;
  const overhang = opts.jaw_overhang_mm ?? 10;
  const axis = opts.clamp_axis ?? "X";
  const zTop = max.z;
  const clampZ0 = min.z + (max.z - min.z) / 3;
  const clampZ1 = min.z + (max.z - min.z) * 0.8;

  const candidates: FixtureCandidate[] = [];
  if (axis === "X") {
    // 平口钳：左右颚夹持 X± 面，接触带在零件中部高度
    candidates.push({
      id: "fx_vise_x",
      type: "VISE",
      clamp_dir: "+X",
      contact: { x0: min.x, x1: min.x + clampDepth, y0: min.y, y1: max.y, z0: clampZ0, z1: clampZ1 },
      body: { x0: min.x - 40, x1: min.x, y0: min.y - 15, y1: max.y + 15, z0: min.z - 30, z1: clampZ1 },
      rationale: ["平口钳 X− 颚夹持", "接触带位于零件 1/3~4/5 高度，避开顶面加工区", "钳体在 X− 侧，刀具从 +Z 接近无干涉"],
    });
    candidates.push({
      id: "fx_softjaw_x",
      type: "SOFT_JAW",
      clamp_dir: "+X",
      contact: { x0: min.x, x1: min.x + clampDepth, y0: min.y, y1: max.y, z0: min.z, z1: clampZ1 },
      body: { x0: min.x - 35, x1: min.x, y0: min.y - 10, y1: max.y + 10, z0: min.z - 25, z1: zTop + overhang },
      rationale: ["软爪仿形包络 X− 面与底角", "爪体高出顶面，保护薄壁", "顶部铣平避让刀路"],
    });
  } else {
    candidates.push({
      id: "fx_vise_y",
      type: "VISE",
      clamp_dir: "+Y",
      contact: { x0: min.x, x1: max.x, y0: min.y, y1: min.y + clampDepth, z0: clampZ0, z1: clampZ1 },
      body: { x0: min.x - 15, x1: max.x + 15, y0: min.y - 40, y1: min.y, z0: min.z - 30, z1: clampZ1 },
      rationale: ["平口钳 Y− 颚夹持", "适用于长边沿 Y 的零件", "钳体在 Y− 侧"],
    });
  }
  return candidates;
}

export interface CollisionResult {
  ok: boolean;
  /** 干涉的夹具 id → 重叠盒 */
  collisions: { fixture_id: string; overlap: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number } }[];
}

/** 夹具包络 vs 刀路包围盒干涉检查（刀具路径任何一点进入夹具本体即判定碰撞） */
export function collisionCheck(fixtures: FixtureCandidate[], toolpathBounds: BBox[]): CollisionResult {
  const collisions: CollisionResult["collisions"] = [];
  for (const fx of fixtures) {
    const b = fx.body;
    for (const tb of toolpathBounds) {
      const overlap = {
        x0: Math.max(b.x0, tb.min.x),
        x1: Math.min(b.x1, tb.max.x),
        y0: Math.max(b.y0, tb.min.y),
        y1: Math.min(b.y1, tb.max.y),
        z0: Math.max(b.z0, tb.min.z),
        z1: Math.min(b.z1, tb.max.z),
      };
      if (overlap.x0 < overlap.x1 && overlap.y0 < overlap.y1 && overlap.z0 < overlap.z1) {
        collisions.push({ fixture_id: fx.id, overlap });
        break;
      }
    }
  }
  return { ok: collisions.length === 0, collisions };
}

export function planFixture(bbox: BBox, opts: FixtureOptions = {}): FixturePlan {
  const locate = planLocators(bbox);
  const candidates = candidateFixtures(bbox, opts);
  const warnings: string[] = [];
  // v1 推荐规则：无侧向特征干涉时优先软爪（保护薄壁），否则平口钳
  const preferred = opts.soft_jaw ? candidates.find((c) => c.type === "SOFT_JAW") : candidates.find((c) => c.type === "VISE");
  const recommended = preferred ?? candidates[0];
  if (opts.soft_jaw && !preferred) {
    // P3-28：soft_jaw=true 但当前夹持轴不产 SOFT_JAW 候选（如 clamp_axis:Y 只产 VISE），
    // 旧实现静默回退——此处显式输出 WARN 决策记录，调用方可见。
    warnings.push(`[WARN] soft_jaw=true 但无 SOFT_JAW 候选（clamp_axis=${opts.clamp_axis ?? "X"}），已回退为 ${recommended?.id ?? "(无)"}`);
  }
  return { locate, candidates, recommended_id: recommended?.id ?? "", warnings };
}

/** 特征是否与夹持面冲突（特征可访问方向含夹持方向或特征贴靠夹持面） */
export interface ClampFeatureLite {
  id: string;
  accessible_directions?: string[];
}

export function clampConflict(features: ClampFeatureLite[], candidate: FixtureCandidate): string[] {
  const conflicts: string[] = [];
  const dir = candidate.clamp_dir as string;
  for (const f of features) {
    const dirs = (f.accessible_directions ?? []) as string[];
    if (dirs.includes(dir) || dirs.includes(dir.replace("+", "-") as never)) {
      // 侧向可访问特征可能从夹持侧加工 → 与夹具接触冲突（保守提示）
      conflicts.push(`${f.id}(可访问 ${dirs.join("/")}，与夹持方向 ${dir} 冲突)`);
    }
  }
  return conflicts;
}
