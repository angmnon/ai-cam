/**
 * CAM 工艺规划器（P2-8 前置）：part + 特征 → Operation[] + ToolpathIR[] + CamIR。
 *
 * 确定性装配规则（v1）：
 * - OUTER_PROFILE → FACE（顶面清 0.05）
 * - POCKET/SLOT/OPEN_POCKET → POCKET（层切+螺旋/开槽进刀）
 * - HOLE_THROUGH/HOLE_BLIND → DRILL（点钻 + 钻孔/啄钻）
 * - BOSS/STEP → CONTOUR outer（绕凸台/台阶轮廓）
 * - CHAMFER → CHAMFER（沿斜面包络轮廓）
 * - 始终追加 CONTOUR_OUTER（零件外轮廓多深度精修）
 * 刀具候选：直径 ≤ 特征约束的最大可用刀具（rank_reason 可解释）。
 * 参数：每 op 走 parameter-engine（规则中值 → 机床硬约束 clamp）。
 */
import type { Tool, Machine, Material, CuttingRule } from "@ai-cam/domain-schemas";
import type { CamIR, CuttingParameters, Operation, ToolpathIR, ToolpathMove } from "@ai-cam/cam-ir";
import { validateCamIR } from "@ai-cam/cam-ir";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import type { Feature } from "@ai-cam/domain-schemas";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import { seedCuttingRules, seedMachines, seedMaterials, seedTools } from "@ai-cam/master-data";
import { computeCuttingParameters, PARAMETER_ENGINE_VERSION, type ComputeParamsResult } from "@ai-cam/parameter-engine";
import { faceOp, pocketOp, profileOp, drillOp } from "./ops/index.js";
import { rect2, rectFromBBox } from "./geometry2d.js";

export const CAM_KERNEL_VERSION = "0.2.0";

/**
 * P2-08 声明式合成特征 id：CONTOUR_OUTER（零件整体外轮廓多深度精修）并非由面识别产生，
 * 而是规划器对整个 part 包络外轮廓合成的工序。这里以稳定常量注册该“边界轮廓特征”，
 * 替代原先的悬空 magic string。它不对应 FeatureGraph 中的任一识别面，是规划器自声明的
 * 约定 id；cam-ir 校验层不跨查 feature_id 引用，故允许此约定 id 存在。
 */
export const PART_PROFILE_FEATURE_ID = "part_profile";

export interface PlannerOptions {
  /** 退刀平面高于零件顶面（默认 20mm） */
  safeClearance?: number;
  /** 顶面清面量（默认 0.05mm） */
  finishAllowance?: number;
  /** 毛坯外扩量（默认 5mm） */
  stockMargin?: number;
  materialId?: string;
  machineId?: string;
  tools?: Tool[];
  rules?: CuttingRule[];
  userOverrides?: Partial<CuttingParameters>;
}

export interface PlanResult {
  cam: CamIR;
  toolpaths: ToolpathIR[];
  parameterDecisions: Record<string, ComputeParamsResult>;
}

interface OpCtx {
  type: Operation["type"];
  name: string;
  featureIds: string[];
  tool: Tool;
  params: CuttingParameters;
  generate: () => ToolpathIR;
}

const rectOf = (f: Feature) => rect2(f.bbox.min.x, f.bbox.min.y, f.bbox.max.x, f.bbox.max.y);
const bboxRect = (p: NormalizedPartModel) => rectFromBBox(p.bbox_mm.min, p.bbox_mm.max);

export function selectTool(
  opType: Operation["type"],
  constraint: { maxDiameter?: number; preferDrillOf?: number },
  tools: Tool[],
): { tool: Tool; reasons: string[] } {
  const candidates = tools.filter((t) => t.stock_qty > 0);
  if (opType === "DRILL" && constraint.preferDrillOf != null) {
    const drills = candidates.filter((t) => t.type === "DRILL");
    const sorted = [...drills].sort((a, b) => Math.abs(a.diameter_mm - constraint.preferDrillOf!) - Math.abs(b.diameter_mm - constraint.preferDrillOf!));
    const best = sorted.find((t) => Math.abs(t.diameter_mm - constraint.preferDrillOf!) <= 1.5);
    if (best) return { tool: best, reasons: [`钻头 ${best.diameter_mm}mm 最接近孔径 ${constraint.preferDrillOf}mm`] };
    const anyDrill = drills.sort((a, b) => a.diameter_mm - b.diameter_mm)[0];
    if (anyDrill) return { tool: anyDrill, reasons: [`无近径钻头，取最小钻头 ${anyDrill.diameter_mm}mm 兜底`] };
    throw new ApiError({
      code: ErrorCodes.CAM_TOOL_REACH_FAILED,
      message: "no DRILL tool in tool set",
      stage: "cam-kernel.selectTool",
      details: { opType, preferDrillOf: constraint.preferDrillOf },
    });
  }
  const maxDia = constraint.maxDiameter ?? 8;
  const pool = candidates.filter((t) => t.type === "FLAT_END_MILL" && t.diameter_mm <= maxDia + 1e-9);
  pool.sort((a, b) => b.diameter_mm - a.diameter_mm);
  if (pool.length === 0) {
    const any = [...candidates].filter((t) => t.type === "FLAT_END_MILL").sort((a, b) => a.diameter_mm - b.diameter_mm);
    if (any.length > 0) return { tool: any[0], reasons: ["无满足约束刀具，取最小平刀兜底"] };
    throw new ApiError({
      code: ErrorCodes.CAM_TOOL_REACH_FAILED,
      message: `no FLAT_END_MILL tool (maxDia ${maxDia})`,
      stage: "cam-kernel.selectTool",
      details: { opType, maxDiameter: maxDia },
    });
  }
  return { tool: pool[0], reasons: [`直径 ${pool[0].diameter_mm}mm ≤ 约束 ${maxDia}mm`] };
}

export function planPart(part: NormalizedPartModel, features: Feature[], options: PlannerOptions = {}): PlanResult {
  const machines = seedMachines;
  const materials = seedMaterials;
  const tools = options.tools ?? seedTools;
  const rules = options.rules ?? seedCuttingRules;
  const machine: Machine = machines.find((m) => m.id === (options.machineId ?? "mch_vmc850")) ?? machines[0];
  const material: Material = materials.find((m) => m.id === (options.materialId ?? "mat_al_6061")) ?? materials[0];

  // P2-10：axis_config 不再硬编码 "3AXIS"，改由所选机床传入（缺省即 3AXIS）。
  // cam-ir MachineProfile 仅接受 3/4/5 轴三值；domain 的 INDEXED_4AXIS 归入 4AXIS。
  const irAxisConfig: "3AXIS" | "4AXIS" | "5AXIS" =
    machine.axis_config === "INDEXED_4AXIS" ? "4AXIS" : machine.axis_config;

  const zTop = part.bbox_mm.max[2];
  const zBottom = part.bbox_mm.min[2];
  const safeZ = zTop + (options.safeClearance ?? 20);
  const margin = options.stockMargin ?? 5;
  const finish = options.finishAllowance ?? 0.05;
  const partRect = bboxRect(part);
  const stockRect = rect2(partRect.x0 - margin, partRect.y0 - margin, partRect.x1 + margin, partRect.y1 + margin);

  const ops: OpCtx[] = [];
  const parameterDecisions: Record<string, ComputeParamsResult> = {};
  let opIndex = 0;

  const paramFor = (opType: Operation["type"], tool: Tool, label: string): ComputeParamsResult => {
    const r = computeCuttingParameters({ tool, material, opType, machine: machine.kinematics, userOverrides: options.userOverrides, rules });
    parameterDecisions[label] = r;
    return r;
  };

  const toolNumber = new Map<string, number>();
  const nextToolNumber = (id: string) => {
    if (!toolNumber.has(id)) toolNumber.set(id, toolNumber.size + 1);
    return toolNumber.get(id)!;
  };

  const maxDiaFor = (minW: number): number => Math.max(2, Math.min(minW * 0.7, 12));

  for (const f of features) {
    const rect = rectOf(f);
    const dims = f.dimensions ?? {};
    const minW = Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0);

    if (f.type === "OUTER_PROFILE") {
      const { tool } = selectTool("FACE", { maxDiameter: Math.max(2, Math.min(stockRect.x1 - stockRect.x0, stockRect.y1 - stockRect.y0) * 0.5) }, tools);
      const p = paramFor("FACE", tool, `FACE_${f.id}`);
      const label = `FACE_${f.id}`;
      ops.push({
        type: "FACE",
        name: "顶面铣削",
        featureIds: [f.id],
        tool,
        params: p.parameters,
        generate: () => mkTp(label, faceOp({ region: stockRect, zCut: zTop - finish, stepover: p.parameters.stepover_mm ?? tool.diameter_mm * 0.6, toolR: tool.diameter_mm / 2, feed: p.parameters.feed_mm_min, plungeFeed: p.parameters.plunge_feed_mm_min ?? p.parameters.feed_mm_min, safeZ })),
      });
    }

    if (f.type === "POCKET" || f.type === "SLOT" || f.type === "OPEN_POCKET") {
      const { tool } = selectTool("POCKET", { maxDiameter: maxDiaFor(minW) }, tools);
      const p = paramFor("POCKET", tool, `POCKET_${f.id}`);
      const label = `POCKET_${f.id}`;
      const openSides = f.accessible_directions.filter((d): d is "+X" | "-X" | "+Y" | "-Y" => d === "+X" || d === "-X" || d === "+Y" || d === "-Y");
      ops.push({
        type: "POCKET",
        name: f.type === "SLOT" ? "贯通槽铣削" : f.type === "OPEN_POCKET" ? "开放腔铣削" : "型腔粗加工",
        featureIds: [f.id],
        tool,
        params: p.parameters,
        generate: () =>
          mkTp(
            label,
            pocketOp({
              region: rect,
              zTop,
              zBottom: f.bbox.max.z,
              stepdown: p.parameters.stepdown_mm ?? tool.diameter_mm,
              stepover: p.parameters.stepover_mm ?? tool.diameter_mm * 0.5,
              toolR: tool.diameter_mm / 2,
              feed: p.parameters.feed_mm_min,
              plungeFeed: p.parameters.plunge_feed_mm_min ?? p.parameters.feed_mm_min,
              safeZ,
              openSides,
            }),
          ),
      });
    }

    if (f.type === "HOLE_THROUGH" || f.type === "HOLE_BLIND") {
      const cx = (rect.x0 + rect.x1) / 2;
      const cy = (rect.y0 + rect.y1) / 2;
      const holeD = dims.diameter_mm ?? rect.x1 - rect.x0;
      const { tool } = selectTool("DRILL", { preferDrillOf: holeD }, tools);
      const p = paramFor("DRILL", tool, `DRILL_${f.id}`);
      const label = `DRILL_${f.id}`;
      const depth = f.type === "HOLE_THROUGH" ? zTop - zBottom + 0.5 : (dims.depth_mm ?? Math.max(0.1, zTop - f.bbox.max.z));
      const depthRatio = tool.diameter_mm > 0 ? depth / tool.diameter_mm : 0;
      ops.push({
        type: "DRILL",
        name: f.type === "HOLE_THROUGH" ? "通孔钻孔" : "盲孔钻孔",
        featureIds: [f.id],
        tool,
        params: p.parameters,
        generate: () =>
          mkTp(
            label,
            drillOp({
              holes: [{ cx, cy, depth, through: f.type === "HOLE_THROUGH" }],
              zTop,
              toolR: tool.diameter_mm / 2,
              feed: p.parameters.feed_mm_min,
              plungeFeed: p.parameters.plunge_feed_mm_min ?? p.parameters.feed_mm_min,
              safeZ,
              spotDepth: 1,
              peckStep: depthRatio > 3 ? 2 * tool.diameter_mm : undefined,
            }),
          ),
      });
    }

    if (f.type === "BOSS" || f.type === "STEP") {
      const height = dims.height_mm ?? Math.max(0.1, f.bbox.max.z - f.bbox.min.z);
      const { tool } = selectTool("CONTOUR", { maxDiameter: Math.min(maxDiaFor(minW), 8) }, tools);
      const p = paramFor("CONTOUR", tool, `CONTOUR_${f.id}`);
      const label = `CONTOUR_${f.id}`;
      ops.push({
        type: "CONTOUR",
        name: f.type === "BOSS" ? "凸台轮廓精加工" : "台阶轮廓精加工",
        featureIds: [f.id],
        tool,
        params: p.parameters,
        generate: () =>
          mkTp(
            label,
            profileOp({ rect, zTop: f.bbox.max.z, zBottom: f.bbox.max.z - height, stepdown: p.parameters.stepdown_mm ?? tool.diameter_mm, toolR: tool.diameter_mm / 2, feed: p.parameters.feed_mm_min, plungeFeed: p.parameters.plunge_feed_mm_min ?? p.parameters.feed_mm_min, safeZ, side: "OUTER" }),
          ),
      });
    }

    if (f.type === "CHAMFER") {
      const { tool } = selectTool("CONTOUR", { maxDiameter: 6 }, tools);
      const p = paramFor("CONTOUR", tool, `CHAMFER_${f.id}`);
      const label = `CHAMFER_${f.id}`;
      ops.push({
        type: "CHAMFER",
        name: "倒角加工",
        featureIds: [f.id],
        tool,
        params: p.parameters,
        generate: () =>
          mkTp(
            label,
            profileOp({ rect, zTop: f.bbox.max.z, zBottom: f.bbox.min.z, stepdown: p.parameters.stepdown_mm ?? tool.diameter_mm, toolR: tool.diameter_mm / 2, feed: p.parameters.feed_mm_min, plungeFeed: p.parameters.plunge_feed_mm_min ?? p.parameters.feed_mm_min, safeZ, side: "OUTER" }),
          ),
      });
    }
  }

  // 外轮廓精修（始终追加）
  {
    const { tool } = selectTool("CONTOUR", { maxDiameter: 8 }, tools);
    const p = paramFor("CONTOUR", tool, "CONTOUR_OUTER");
    ops.push({
      type: "CONTOUR",
      name: "外轮廓精加工",
      featureIds: [PART_PROFILE_FEATURE_ID], // CamIR 要求 feature_ids min(1)；P2-08 稳定约定 id
      tool,
      params: p.parameters,
      generate: () =>
        mkTp(
          "CONTOUR_OUTER",
          profileOp({ rect: partRect, zTop, zBottom: zBottom + finish, stepdown: p.parameters.stepdown_mm ?? tool.diameter_mm, toolR: tool.diameter_mm / 2, feed: p.parameters.feed_mm_min, plungeFeed: p.parameters.plunge_feed_mm_min ?? p.parameters.feed_mm_min, safeZ, side: "OUTER" }),
        ),
    });
  }

  // 装配
  const operations: Operation[] = [];
  const toolpaths: ToolpathIR[] = [];
  const toolRefs = new Map<string, number>();

  for (const ctx of ops) {
    const tp = ctx.generate();
    tp.move_count = tp.moves.length;
    tp.bounds = computeBounds(tp.moves);
    toolpaths.push(tp);
    const toolId = ctx.tool.id;
    if (!toolRefs.has(toolId)) toolRefs.set(toolId, nextToolNumber(toolId));
    const depends_on = opIndex > 0 ? [operations[opIndex - 1].id] : [];
    operations.push({
      id: tp.operation_id,
      op_index: ++opIndex,
      name: ctx.name,
      type: ctx.type,
      setup_id: "setup_1",
      feature_ids: ctx.featureIds,
      tool: { tool_id: toolId, tool_number: toolRefs.get(toolId), rank: 1, rank_reason: [ctx.name] },
      parameters: ctx.params,
      depends_on,
      safe_z_mm: safeZ,
      tolerance_mm: 0.01,
    });
  }

  const partId = part.file.replace(/\.[^.]+$/, "");
  const cam: CamIR = {
    schema_version: "1.0.0",
    ir_id: `ir_${partId}_${CAM_KERNEL_VERSION}`,
    job_id: `job_${partId}`,
    part_id: partId,
    units: { length: "mm", angle: "deg", speed: "rpm", feed: "mm/min" },
    machine: { machine_id: machine.id, machine_name: machine.name, controller_id: machine.supported_controllers[0], axis_config: irAxisConfig, travel: machine.kinematics.travel, max_spindle_rpm: machine.kinematics.max_spindle_rpm, max_feed: machine.kinematics.max_feed_mm_min },
    material: { material_id: material.id, material_name: material.name, grade: material.grade },
    // P2-10：毛坯底面 origin.z 不再硬编码 0，对齐 part 包络底面 bbox.min.z，保证毛坯真正包络零件底面。
    stock: { id: "stock_1", kind: "BOX", dimensions: { x: stockRect.x1 - stockRect.x0, y: stockRect.y1 - stockRect.y0, z: zTop + margin }, origin: { x: stockRect.x0, y: stockRect.y0, z: zBottom }, margin: { x: margin, y: margin, z: margin } },
    setups: [{ id: "setup_1", name: "G54 底定位", wcs: "G54", origin: { x: 0, y: 0, z: 0 } }],
    tools: [...toolRefs.entries()].map(([tool_id, tool_number]) => ({ tool_id, tool_number })),
    operations,
    toolpaths,
    metadata: { generated_by: "cam-kernel", generator_version: CAM_KERNEL_VERSION, created_at: new Date().toISOString(), preferences: { engine: "deterministic", param_engine: PARAMETER_ENGINE_VERSION } },
  };

  // 产出端校验（P2-09）：装配完成的 CamIR 必须通过 cam-ir 校验，否则视为内核产物非法。
  const validation = validateCamIR(cam);
  if (!validation.ok) {
    const first = validation.issues.find((i) => i.severity === "ERROR");
    throw new ApiError({
      code: ErrorCodes.CAM_IR_INVALID,
      message: first ? `CamIR 校验失败: ${first.message}` : "CamIR 校验失败",
      stage: "cam-kernel.planPart",
      details: { issues: validation.issues, hash: validation.hash },
    });
  }

  return { cam, toolpaths, parameterDecisions };
}

function mkTp(operationId: string, moves: ToolpathMove[]): ToolpathIR {
  return { operation_id: operationId, toolpath_id: `${operationId}_tp`, moves, engine_version: CAM_KERNEL_VERSION, move_count: moves.length };
}

export function computeBounds(moves: ToolpathMove[]): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const m of moves) {
    min.x = Math.min(min.x, m.x);
    min.y = Math.min(min.y, m.y);
    min.z = Math.min(min.z, m.z);
    max.x = Math.max(max.x, m.x);
    max.y = Math.max(max.y, m.y);
    max.z = Math.max(max.z, m.z);
  }
  return { min, max };
}
