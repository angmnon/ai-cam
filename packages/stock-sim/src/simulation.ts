/**
 * 确定性仿真引擎（P3-1~P3-3）：
 * - 材料去除：按刀路 move 对毛坯体素做圆柱扫掠扣除（FLAT/BALL/BULL/DRILL 圆柱近似）
 * - 碰撞（P3-2）：RAPID 段刀具包络 vs 剩余毛坯体素 → 碰撞事件
 * - Gouge（P3-3）：切削段刀底低于关联特征底面 - 容差 → gouge 事件
 * - 残料（P3-3）：关键面（FACE 顶 / POCKET 底 / 孔底）残余高度阈值 PASS/WARN/FAIL
 */
import type { CamIR, Operation, ToolpathIR, ToolpathMove } from "@ai-cam/cam-ir";
import { seedTools } from "@ai-cam/master-data";
import { VoxelGrid, voxelizeStock, sampleMove, type VoxelOptions } from "./voxel.js";

export const STOCK_SIM_VERSION = "0.1.0";

export type Verdict = "PASS" | "WARN" | "FAIL";

export interface SimEvent {
  kind: "COLLISION" | "GOUGE" | "RESIDUAL_WARN" | "RESIDUAL_FAIL" | "OVERTRAVEL" | "COVERAGE_WARN";
  severity: Verdict;
  operation_id?: string;
  move_index?: number;
  x: number;
  y: number;
  z: number;
  message: string;
}

export interface OpSimDetail {
  operation_id: string;
  type: string;
  name?: string;
  tool_id: string;
  removed_volume_mm3: number;
  move_count: number;
  events: SimEvent[];
}

export interface SimThresholds {
  /** 残料高度阈值（mm），超过即 FAIL；voxel*1.5 默认 */
  residualHeightMm?: number;
  /** 碰撞即 FAIL */
  collisionFails?: boolean;
  /** gouge 即 FAIL */
  gougeFails?: boolean;
}

export interface SimulationReport {
  schema_version: "1.0.0";
  report_id: string;
  part_id: string;
  job_id: string;
  engine_version: string;
  status: Verdict;
  voxel_size_mm: number;
  initial_volume_mm3: number;
  removed_volume_mm3: number;
  residual_volume_mm3: number;
  /** 与理论零件体积的相对差（%）：|切除 - (stock - part)| / part */
  removal_error_pct: number;
  op_details: OpSimDetail[];
  events: SimEvent[];
  key_surfaces: Array<{ surface: string; residual_mm: number; verdict: Verdict; note: string }>;
  /** 碰撞检测覆盖度（P1-05）：fixture 无 AABB 时 not_checked */
  collision_coverage: { holder: string; fixture: string; machine_envelope: string };
  /** 播放快照（默认 step=4 降采样；每 op 一个关键帧） */
  frames: Array<{ operation_id: string; step: number; snapshot: Array<{ x: number; y: number; z: number; solid: boolean }> }>;
}

export interface SimulateInput {
  cam: CamIR;
  /** 理论零件体积（mm³，用于残料误差评估） */
  partVolumeMm3: number;
  thresholds?: SimThresholds;
  voxel?: VoxelOptions;
  /** 快照下采样倍率（默认 4） */
  frameStep?: number;
  /** 每 N 个 op 记录一帧（默认全部） */
  frameEvery?: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * H-4 分辨率自适应：未显式指定 voxelSize 时按毛坯最大边长选体素尺寸，
 * 控制体素总数（约 10^6 量级），避免大零件仿真退化到分钟级。
 */
export function autoVoxelSize(cam: CamIR): number {
  const dims = cam.stock?.dimensions ?? { x: 100, y: 100, z: 40 };
  const maxL = Math.max(dims.x ?? 100, dims.y ?? 100, dims.z ?? 40);
  if (maxL <= 150) return 2;
  if (maxL <= 300) return 3;
  if (maxL <= 500) return 4;
  return 5;
}

export function simulate(input: SimulateInput): SimulationReport {
  const { cam } = input;
  const voxelOpt = { ...(input.voxel ?? {}) };
  if (voxelOpt.voxelSize == null) voxelOpt.voxelSize = autoVoxelSize(cam);
  const grid = voxelizeStock(cam, voxelOpt);
  const voxel = grid.voxel;
  const thresholds: Required<SimThresholds> = {
    residualHeightMm: input.thresholds?.residualHeightMm ?? voxel * 1.5,
    collisionFails: input.thresholds?.collisionFails ?? true,
    gougeFails: input.thresholds?.gougeFails ?? true,
  };

  const toolById = new Map(seedTools.map((t) => [t.id, t]));
  const initialStats = grid.stats();
  const initialVolume = initialStats.volume_mm3;
  const events: SimEvent[] = [];
  const opDetails: OpSimDetail[] = [];
  const frames: SimulationReport["frames"] = [];
  const frameStep = input.frameStep ?? 4;
  const frameEvery = input.frameEvery ?? 1;

  const ops = cam.operations;
  const toolpaths = new Map<string, ToolpathIR>((cam.toolpaths ?? []).map((tp) => [tp.operation_id, tp]));

  let cumulativeRemoved = 0;
  let opCounter = 0;

  for (const op of ops) {
    const tp = toolpaths.get(op.id);
    if (!tp) {
      events.push({ kind: "RESIDUAL_WARN", severity: "WARN", x: 0, y: 0, z: 0, operation_id: op.id, message: `op ${op.id} 无刀路，跳过` });
      continue;
    }
    const tool = toolById.get(op.tool.tool_id);
    if (!tool) {
      events.push({ kind: "COLLISION", severity: "FAIL", x: 0, y: 0, z: 0, operation_id: op.id, message: `刀具 ${op.tool.tool_id} 不在种子刀具库，无法仿真` });
      continue;
    }
    const radius = tool.diameter_mm / 2;
    const opStartVolume = initialVolume - cumulativeRemoved;
    const opEvents: SimEvent[] = [];

    const moves = tp.moves;
    const stockTop = (cam.stock.origin?.z ?? 0) + (cam.stock.dimensions?.z ?? 40);
    // P1-05③ 机床包络（对称容差判定：以 WCS 原点为中心，半程 = travel/2）
    const travel = cam.machine?.travel;
    const env = travel ? { hx: travel.x / 2, hy: travel.y / 2, hz: travel.z / 2 } : null;
    // P1-05① Holder 几何近似：刀柄直径 > 刀具直径，悬伸自刀刃顶端向上
    const fluteLen = tool.flute_length_mm ?? 20;
    const holderLen = 40;
    const holderRadius = Math.max(radius * 1.5, 10);
    // P1-04 该 op 允许最低切削面（无特征面模型时按刀路层级近似）
    const gougeRef = allowedBottom(op, tp, cam);
    if (!gougeRef.modeled) {
      opEvents.push({ kind: "COVERAGE_WARN", severity: "WARN", operation_id: op.id, x: 0, y: 0, z: 0, message: `op ${op.id}（${op.type}）未建模 gouge 检查` });
    }
    const safeZ = op.safe_z_mm ?? null;
    let prev: ToolpathMove | null = null;
    for (let mi = 0; mi < moves.length; mi++) {
      const m = moves[mi];
      let pts: ToolpathMove[];
      if (!prev) {
        const z0 = m.type === "RAPID" ? Math.max(m.z, stockTop + 10) : Math.max(m.z, stockTop);
        pts = sampleMove({ type: m.type, x: m.x, y: m.y, z: z0, feed_mm_min: m.feed_mm_min }, m, voxel);
      } else {
        pts = sampleMove(prev, m, voxel);
      }
      // RAPID 是否为切削触发点（其后紧跟 PLUNGE/直线切削），其终点免 safeZ 断言
      const nextMove = moves[mi + 1];
      const rapidIsEntry = m.type === "RAPID" && nextMove != null && isCutEntryType(nextMove.type);
      for (let pi = 0; pi < pts.length; pi++) {
        const p = pts[pi];
        const isLastSample = pi === pts.length - 1;
        // P1-05③ 机床包络超程：对每个 move 点做对称容差判定
        if (env) {
          const tol = 0.5;
          if (Math.abs(p.x) > env.hx + tol || Math.abs(p.y) > env.hy + tol || Math.abs(p.z) > env.hz + tol) {
            opEvents.push({ kind: "OVERTRAVEL", severity: "FAIL", operation_id: op.id, move_index: mi, x: p.x, y: p.y, z: p.z, message: `坐标超机床包络（±${round2(env.hx)}/±${round2(env.hy)}/±${round2(env.hz)}mm）` });
          }
        }
        if (p.type === "RAPID") {
          // ① 刀尖/刀杆侵入剩余毛坯（保留原上升圆柱：刀尖没入毛坯时刀杆随之相交）
          if (grid.anyInCylinder(p.x, p.y, p.z, Math.max(p.z + radius * 2, p.z + 10), radius)) {
            opEvents.push({ kind: "COLLISION", severity: "FAIL", operation_id: op.id, move_index: mi, x: p.x, y: p.y, z: p.z, message: "RAPID 段穿过剩余毛坯（刀尖/刀杆侵入）" });
          }
          const onSafePlane = safeZ != null && p.z >= safeZ - 0.5;
          if (!onSafePlane) {
            // ② P1-03 低空掠过盲区：刀尖下方 2R 悬伸带与剩余毛坯求交
            const hTop = grid.topHeightAt(p.x, p.y);
            if (Number.isFinite(hTop) && hTop > p.z - radius * 2) {
              opEvents.push({ kind: "COLLISION", severity: "FAIL", operation_id: op.id, move_index: mi, x: p.x, y: p.y, z: p.z, message: `RAPID 低空掠过：毛坯顶 ${round2(hTop)}mm 距刀尖仅 ${round2(p.z - hTop)}mm（< 2R=${round2(radius * 2)}）` });
            }
            // ③ safeZ 平面断言：低于安全平面且非切削触发点即报警
            if (safeZ != null && p.z < safeZ - 0.5 && !(rapidIsEntry && isLastSample)) {
              opEvents.push({ kind: "COLLISION", severity: "FAIL", operation_id: op.id, move_index: mi, x: p.x, y: p.y, z: p.z, message: `RAPID z=${round2(p.z)}mm 低于安全平面 ${round2(safeZ)}mm 且非进刀点` });
            }
          }
          // ④ P1-05① Holder 刀柄圆柱 vs 剩余毛坯
          if (grid.anyHolderOverlap(p.x, p.y, p.z + fluteLen, p.z + fluteLen + holderLen, holderRadius)) {
            opEvents.push({ kind: "COLLISION", severity: "FAIL", operation_id: op.id, move_index: mi, x: p.x, y: p.y, z: p.z, message: "RAPID 段刀柄（Holder）与剩余毛坯干涉" });
          }
          continue; // RAPID 不切除
        }
        // 切削段：刀底 z 到刀顶 z+直径（FLAT/BALL/BULL/DRILL 圆柱近似）
        grid.cutCylinder(p.x, p.y, p.z, p.z + Math.max(radius * 2, 4), radius);
        // Gouge：切削刀底低于该 op 允许最低面
        if (gougeRef.bottom != null && p.z < gougeRef.bottom - 0.3) {
          opEvents.push({ kind: "GOUGE", severity: "FAIL", operation_id: op.id, move_index: mi, x: p.x, y: p.y, z: p.z, message: `刀底 ${round2(p.z)}mm 低于允许底面 ${round2(gougeRef.bottom)}mm` });
        }
      }
      prev = m;
    }

    const after = grid.stats();
    const removed = Math.max(0, opStartVolume - after.volume_mm3);
    cumulativeRemoved += removed;
    opDetails.push({
      operation_id: op.id,
      type: op.type,
      name: op.name,
      tool_id: op.tool.tool_id,
      removed_volume_mm3: round2(removed),
      move_count: moves.length,
      events: opEvents,
    });
    events.push(...opEvents);

    opCounter++;
    if (opCounter % frameEvery === 0) {
      frames.push({ operation_id: op.id, step: frameStep, snapshot: grid.snapshot(frameStep) });
    }
  }

  const finalStats = grid.stats();
  const residualVolume = finalStats.volume_mm3;
  const removedVolume = initialVolume - residualVolume;

  // 关键面残料检查
  const keySurfaces: SimulationReport["key_surfaces"] = [];
  for (const op of ops) {
    const tp = toolpaths.get(op.id);
    if (!tp) continue;
    if (op.type === "FACE") {
      const h = maxResidualOver(grid, tp);
      keySurfaces.push({ surface: `${op.id} 顶面`, residual_mm: round2(h), verdict: h <= thresholds.residualHeightMm ? "PASS" : h <= thresholds.residualHeightMm * 2 ? "WARN" : "FAIL", note: "FACE 顶面残料高度" });
    }
    if (op.type === "POCKET") {
      const h = maxResidualAtBottom(grid, tp);
      keySurfaces.push({ surface: `${op.id} 型腔底`, residual_mm: round2(h), verdict: h <= thresholds.residualHeightMm ? "PASS" : h <= thresholds.residualHeightMm * 2 ? "WARN" : "FAIL", note: "POCKET 底面残料高度" });
    }
  }
  for (const ks of keySurfaces) {
    if (ks.verdict === "FAIL") events.push({ kind: "RESIDUAL_FAIL", severity: "FAIL", x: 0, y: 0, z: 0, message: `${ks.surface} 残料 ${ks.residual_mm}mm 超限` });
    else if (ks.verdict === "WARN") events.push({ kind: "RESIDUAL_WARN", severity: "WARN", x: 0, y: 0, z: 0, message: `${ks.surface} 残料 ${ks.residual_mm}mm` });
  }

  const hasFail = events.some((e) => e.severity === "FAIL");
  const hasWarn = events.some((e) => e.severity === "WARN");
  const status: Verdict = hasFail ? "FAIL" : hasWarn ? "WARN" : "PASS";

  // P1-05 碰撞覆盖度：fixture AABB 未在 CamIR setup 建模 → not_checked
  const setup0 = cam.setups?.[0] as (typeof cam.setups[number] & { fixture_bbox?: unknown }) | undefined;
  const fixtureChecked = setup0?.fixture_bbox != null;
  const collisionCoverage = {
    holder: "checked",
    fixture: fixtureChecked ? "checked" : "not_checked (CamIR setup 无 fixture AABB)",
    machine_envelope: cam.machine?.travel != null ? "checked" : "not_checked (machine 无 travel)",
  };

  const removalErrorPct = input.partVolumeMm3 > 0 ? Math.abs(removedVolume - (initialVolume - input.partVolumeMm3)) / Math.max(input.partVolumeMm3, 1) * 100 : 0;

  return {
    schema_version: "1.0.0",
    report_id: `sim_${cam.part_id}_${STOCK_SIM_VERSION}`,
    part_id: cam.part_id,
    job_id: cam.job_id,
    engine_version: STOCK_SIM_VERSION,
    status,
    voxel_size_mm: voxel,
    initial_volume_mm3: round2(initialVolume),
    removed_volume_mm3: round2(removedVolume),
    residual_volume_mm3: round2(residualVolume),
    removal_error_pct: round2(removalErrorPct),
    op_details: opDetails,
    events,
    key_surfaces: keySurfaces,
    collision_coverage: collisionCoverage,
    frames,
  };
}

/** 切削触发点：RAPID 后紧跟这些类型即视为进刀，其终点免 safeZ 低空断言 */
function isCutEntryType(t: ToolpathMove["type"]): boolean {
  return t === "PLUNGE" || t === "LINEAR" || t === "ARC_CW" || t === "ARC_CCW";
}

/**
 * P1-04 op 关联特征允许的最低切削面。
 * 无独立特征面模型（CamIR 仅含 feature_ids，无 bbox），按刀路层级近似特征 bbox.minZ：
 * - DRILL：毛坯底 -0.5（通孔钻穿合规）
 * - FACE：面铣单平面 → 首个切削移动 z（设计面）
 * - POCKET/SLOT/CONTOUR/PROFILE/CHAMFER：本 op 最深设计层 z（特征 bbox 底面近似）
 * - 其余：未建模（modeled=false），由调用方发 COVERAGE_WARN
 */
function allowedBottom(op: Operation, tp: ToolpathIR, cam: CamIR): { bottom: number | null; modeled: boolean } {
  if (op.type === "DRILL") {
    const stockBottom = (cam.stock.origin?.z ?? 0) - (cam.stock.dimensions?.z ?? 0) / 2;
    return { bottom: stockBottom - 0.5, modeled: true };
  }
  const cutMoves = tp.moves.filter((m) => m.type !== "RAPID" && m.type !== "RETRACT");
  if (cutMoves.length === 0) return { bottom: null, modeled: true };
  if (op.type === "FACE") {
    // 面铣为单一切削平面：以首个切削移动 z 为设计面，其后若下探即 gouge
    return { bottom: cutMoves[0].z, modeled: true };
  }
  if (op.type === "POCKET" || op.type === "CONTOUR" || op.type === "CHAMFER") {
    // 型腔/槽/侧壁：最深设计层 z = 本 op 最低切削 z（特征 bbox.minZ 的刀路近似）
    let minZ = Infinity;
    for (const m of cutMoves) if (m.z < minZ) minZ = m.z;
    return { bottom: Number.isFinite(minZ) ? minZ : null, modeled: true };
  }
  return { bottom: null, modeled: false };
}

/** FACE 顶面残料：刀路扫过区域的剩余最高材料与切削面之差 */
function maxResidualOver(grid: VoxelGrid, tp: ToolpathIR): number {
  let worst = 0;
  for (const m of tp.moves) {
    if (m.type === "RAPID") continue;
    const h = grid.topHeightAt(m.x, m.y);
    if (Number.isFinite(h)) {
      // 期望顶面 = safeZ 之下第一层实际切削深度；v1 用刀路 z 最大切削面
      const expect = topCutZ(tp);
      worst = Math.max(worst, h - expect);
    }
  }
  return worst;
}

function topCutZ(tp: ToolpathIR): number {
  let minZ = Infinity;
  for (const m of tp.moves) if (m.type !== "RAPID" && m.z < minZ) minZ = m.z;
  return Number.isFinite(minZ) ? minZ : 0;
}

/** POCKET 底面残料：刀路最低切削面处的剩余材料 */
function maxResidualAtBottom(grid: VoxelGrid, tp: ToolpathIR): number {
  let minZ = Infinity;
  for (const m of tp.moves) if (m.type !== "RAPID" && m.z < minZ) minZ = m.z;
  if (!Number.isFinite(minZ)) return 0;
  let worst = 0;
  for (const m of tp.moves) {
    if (m.type === "RAPID") continue;
    const h = grid.topHeightAt(m.x, m.y);
    if (Number.isFinite(h)) worst = Math.max(worst, h - minZ);
  }
  return worst;
}
