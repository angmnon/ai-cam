/**
 * Indexed 4 轴组装（P5-1）：把多 Setup 的子计划合并为带 INDEX_ROTATE 的完整 CamIR。
 */
import type { CamIR, Operation, Setup, ToolpathIR } from "@ai-cam/cam-ir";
import type { Feature } from "@ai-cam/domain-schemas";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import { planPart, type PlannerOptions } from "@ai-cam/cam-kernel";
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

  const setups: Setup[] = [];
  const ops: Operation[] = [];
  const toolpaths: ToolpathIR[] = [];
  const per_setup: Indexed4AxisResult["per_setup"] = {};
  let opIndex = 0;
  let toolNumberSeq = 1;

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
        tool: { tool_id: "INDEX", tool_number: toolNumberSeq },
        parameters: { spindle_speed_rpm: 1, feed_mm_min: 1, coolant: "OFF", source: "ENGINE" },
        depends_on: [],
      };
      ops.push(rotOp);
    }
    if (subset.length === 0) {
      per_setup[angle] = { operation_count: 0, feature_count: 0, wcs: angle === 0 ? "G54" : "G55" };
      continue;
    }
    const sub = planPart(part, subset, { ...options, machineId: options.machineId ?? "mch_vmc850", materialId: options.materialId ?? "mat_al_6061" });
    for (const op of sub.cam.operations) {
      ops.push({
        ...op,
        id: `${op.id}`,
        op_index: ++opIndex,
        setup_id: setupId,
        tool: { ...op.tool, tool_number: toolNumberSeq++ },
      });
    }
    for (const tp of sub.toolpaths) toolpaths.push({ ...tp });
    per_setup[angle] = { operation_count: sub.cam.operations.length, feature_count: subset.length, wcs: angle === 0 ? "G54" : "G55" };
  }

  const toolSet = new Map<string, { tool_id: string; tool_number: number }>();
  toolSet.set("INDEX", { tool_id: "INDEX", tool_number: 1 });
  const subCams: CamIR[] = [];
  for (const angle of angles) {
    const subset = byAngle.get(angle) ?? [];
    if (subset.length === 0) continue;
    const sub = planPart(part, subset, { ...options, machineId: options.machineId ?? "mch_vmc850", materialId: options.materialId ?? "mat_al_6061" });
    subCams.push(sub.cam);
  }
  for (const c of subCams) for (const t of c.tools) if (!toolSet.has(t.tool_id)) toolSet.set(t.tool_id, { tool_id: t.tool_id, tool_number: toolSet.size + 1 });

  const cam: CamIR = {
    schema_version: "1.0.0",
    ir_id: `ir4x_${part.file.replace(/\.[^.]+$/, "")}`,
    job_id: `job4x_${part.file.replace(/\.[^.]+$/, "")}`,
    part_id: part.file,
    units: { length: "mm", angle: "deg", speed: "rpm", feed: "mm/min" },
    machine: {
      machine_id: options.machineId ?? "mch_vmc850",
      machine_name: "VMC850 (4-Axis Index)",
      axis_config: "INDEXED_4AXIS",
      controller_id: "FANUC",
      max_spindle_rpm: 8000,
      max_feed: 12000,
    },
    material: { material_id: options.materialId ?? "mat_al_6061", material_name: "6061-T6", grade: "Al" },
    stock: { id: "stock_box", kind: "BOX", dimensions: { x: 80, y: 50, z: 30 }, margin: { x: 5, y: 5, z: 5 } },
    setups,
    tools: [...toolSet.values()],
    operations: ops,
    toolpaths,
    metadata: { generated_by: "axis-4", generator_version: "0.1.0", created_at: new Date().toISOString() },
  };
  return { setups, assignments, index_ops: ops.filter((o) => o.type === "INDEX_ROTATE"), per_setup, cam };
}
