/**
 * Indexed 4 轴组装（P5-1）：把多 Setup 的子计划合并为带 INDEX_ROTATE 的完整 CamIR。
 */
import type { CamIR, Operation, Setup, ToolpathIR } from "@ai-cam/cam-ir";
import type { Feature } from "@ai-cam/domain-schemas";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import { planPart, type PlannerOptions, type PlanResult } from "@ai-cam/cam-kernel";
import { assignFeaturesToSetups, type FeatureAssignment } from "./assign.js";
import type { IndexAxis } from "./transform.js";

export interface Indexed4AxisOptions extends PlannerOptions {
  axis?: IndexAxis;
  /** 参与旋转的角度（默认 0/90/180/270） */
  angles?: number[];
}

export interface Indexed4AxisResult {
  setups: Setup[];
  assignments: FeatureAssignment[];
  index_ops: Operation[];
  /** 每个角度的子计划（角度 → ops 摘要） */
  per_setup: Record<number, { operation_count: number; feature_count: number; wcs: string }>;
  cam: CamIR;
}

/** 每个角度的子 CAM 由 cam-kernel 生成，合并进单一 CamIR，角度切换处插入 INDEX_ROTATE 操作 */
export function planIndexed4Axis(part: NormalizedPartModel, features: Feature[], options: Indexed4AxisOptions = {}): Indexed4AxisResult {
  const axis = options.axis ?? "A";
  const angles = options.angles ?? [0, 90, 180, 270];
  const { assignments } = assignFeaturesToSetups(features, axis, angles);

  const byAngle = new Map<number, Feature[]>();
  for (const a of angles) byAngle.set(a, []);
  for (const as of assignments) byAngle.get(as.angle)?.push(features.find((f) => f.id === as.feature_id)!);

  // P2-15(1)：毛坯从 part bbox 计算，各方向外放 1mm 余量（替代原 80×50×30 / margin 5 硬编码）
  const STOCK_ALLOWANCE_MM = 1;
  const bmin = part.bbox_mm.min;
  const bmax = part.bbox_mm.max;
  const stockDimensions = {
    x: (bmax[0] - bmin[0]) + 2 * STOCK_ALLOWANCE_MM,
    y: (bmax[1] - bmin[1]) + 2 * STOCK_ALLOWANCE_MM,
    z: (bmax[2] - bmin[2]) + 2 * STOCK_ALLOWANCE_MM,
  };
  const stockMargin = { x: STOCK_ALLOWANCE_MM, y: STOCK_ALLOWANCE_MM, z: STOCK_ALLOWANCE_MM };

  // P2-15(3)：INDEX_ROTATE 为非切削分度动作（空转、不换刀）。原占位刀具 id "INDEX" 在
  // master-data 中不存在（非法引用）；改绑 master-data 真实常备刀 tool_em_6（平刀 Ø6，
  // 见 packages/master-data/src/seeds.ts）作为 IR 引用占位，Post 层对该动作不输出换刀。
  const INDEX_TOOL_ID = "tool_em_6";

  // P2-15(4)：同一 subset（角度）只 planPart 一次并缓存复用（替代原每角度重复 planPart 两次）。
  const subPlans = new Map<number, PlanResult>();
  for (const angle of angles) {
    const subset = byAngle.get(angle) ?? [];
    if (subset.length === 0) continue;
    subPlans.set(angle, planPart(part, subset, { ...options, machineId: options.machineId ?? "mch_vmc850", materialId: options.materialId ?? "mat_al_6061" }));
  }

  // P2-15(5)：跨角度/跨工序统一刀号——同一物理刀具 id（master-data 刀唯一键）首次出现分配 T，
  // 之后复用同一 T（替代原每工序 toolNumberSeq++ 导致同一把物理刀跨 op 拿到不同 T）。
  const toolNumberByToolId = new Map<string, number>();
  const nextToolNumber = (toolId: string): number => {
    if (!toolNumberByToolId.has(toolId)) toolNumberByToolId.set(toolId, toolNumberByToolId.size + 1);
    return toolNumberByToolId.get(toolId)!;
  };

  const setups: Setup[] = [];
  const ops: Operation[] = [];
  const toolpaths: ToolpathIR[] = [];
  const per_setup: Indexed4AxisResult["per_setup"] = {};
  let opIndex = 0;

  for (const angle of angles) {
    const subset = byAngle.get(angle) ?? [];
    const setupId = `s${angle}`;
    setups.push({
      id: setupId,
      name: `A${angle}`,
      wcs: angle === 0 ? "G54" : "G55",
      origin: { x: 0, y: 0, z: 0 },
      rotation: angle === 0 ? undefined : { axis, angle },
      part_faces: subset.map((f) => f.id),
    });
    if (angle !== 0 && subset.length > 0) {
      // 旋转索引：切到该角度（真实机床在 Post 层输出 A/B 轴，这里记录 IR 语义）
      const rotOp: Operation = {
        id: `rot_${angle}`,
        op_index: ++opIndex,
        name: `INDEX_ROTATE A${angle}`,
        type: "INDEX_ROTATE",
        setup_id: setupId,
        feature_ids: subset.length > 0 ? [subset[0].id] : [],
        tool: { tool_id: INDEX_TOOL_ID, tool_number: nextToolNumber(INDEX_TOOL_ID) },
        parameters: { spindle_speed_rpm: 1, feed_mm_min: 1, coolant: "OFF", source: "ENGINE" },
        depends_on: [],
      };
      ops.push(rotOp);
    }
    if (subset.length === 0) {
      per_setup[angle] = { operation_count: 0, feature_count: 0, wcs: angle === 0 ? "G54" : "G55" };
      continue;
    }
    const sub = subPlans.get(angle)!;
    for (const op of sub.cam.operations) {
      ops.push({
        ...op,
        id: `${op.id}`,
        op_index: ++opIndex,
        setup_id: setupId,
        tool: { ...op.tool, tool_number: nextToolNumber(op.tool.tool_id) },
      });
    }
    for (const tp of sub.toolpaths) toolpaths.push({ ...tp });
    per_setup[angle] = { operation_count: sub.cam.operations.length, feature_count: subset.length, wcs: angle === 0 ? "G54" : "G55" };
  }

  // P2-15(2)：真实控制器 id 取自 master-data 种子（cam-kernel 已按 machineId 解析
  // supported_controllers[0]，如 mch_vmc850 → ctl_fanuc_0imf）；替代原硬编码方言串 "FANUC"。
  const firstSub = subPlans.size > 0 ? [...subPlans.values()][0] : undefined;
  const controllerId = firstSub?.cam.machine.controller_id ?? "ctl_fanuc_0imf";

  const cam: CamIR = {
    schema_version: "1.0.0",
    ir_id: `ir4x_${part.file.replace(/\.[^.]+$/, "")}`,
    job_id: `job4x_${part.file.replace(/\.[^.]+$/, "")}`,
    part_id: part.file,
    units: { length: "mm", angle: "deg", speed: "rpm", feed: "mm/min" },
    machine: {
      machine_id: options.machineId ?? "mch_vmc850",
      machine_name: "VMC850 (4-Axis Index)",
      // cam-ir MachineProfile 仅接受 3AXIS/4AXIS/5AXIS 三值；domain 的 INDEXED_4AXIS 归入 4AXIS
      // （与 cam-kernel planner.ts 的 axis_config 映射保持一致）。
      axis_config: "4AXIS",
      controller_id: controllerId,
      max_spindle_rpm: 8000,
      max_feed: 12000,
    },
    material: { material_id: options.materialId ?? "mat_al_6061", material_name: "6061-T6", grade: "Al" },
    stock: { id: "stock_box", kind: "BOX", dimensions: stockDimensions, margin: stockMargin },
    setups,
    tools: [...toolNumberByToolId.entries()].map(([tool_id, tool_number]) => ({ tool_id, tool_number })),
    operations: ops,
    toolpaths,
    metadata: { generated_by: "axis-4", generator_version: "0.1.0", created_at: new Date().toISOString() },
  };
  return { setups, assignments, index_ops: ops.filter((o) => o.type === "INDEX_ROTATE"), per_setup, cam };
}
