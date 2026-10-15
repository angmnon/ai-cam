/**
 * Job 报告（P3-9）：工艺单 / 刀具清单 / Setup Sheet / 仿真摘要（结构化 JSON，供打印/下载）。
 */
import type { CamIR } from "@ai-cam/cam-ir";
import type { SimulationReport } from "@ai-cam/stock-sim";
import type { NcProgram } from "@ai-cam/post-core";
import type { ValidationReport } from "@ai-cam/nc-validator";
import { seedTools } from "@ai-cam/master-data";

export interface JobReport {
  schema_version: "1.0.0";
  part_id: string;
  job_id: string;
  ir_id: string;
  program_number: string;
  status: "PASS" | "WARN" | "FAIL";
  validated: boolean;
  engine_version: string;
  generated_at: string;
  summary: {
    part_id: string;
    machine: string;
    machine_id: string;
    controller: string;
    controller_id: string;
    axis_config: string;
    material: string;
    material_id: string;
    stock: { kind: string; dimensions: Record<string, number> };
    operation_count: number;
    tool_count: number;
  };
  setup_sheet: Array<{ setup_id: string; name?: string; wcs: string; origin: { x: number; y: number; z: number } }>;
  tool_list: Array<{ tool_id: string; tool_number: number; name: string; type: string; diameter_mm: number; operations: string[] }>;
  process_sheet: Array<{
    op_index: number;
    operation_id: string;
    type: string;
    name?: string;
    tool_id: string;
    tool_number: number;
    spindle_rpm: number;
    feed_mm_min: number;
    stepdown_mm?: number;
    coolant: string;
    move_count: number;
    feature_ids: string[];
  }>;
  simulation: {
    status: "PASS" | "WARN" | "FAIL";
    voxel_size_mm: number;
    initial_volume_mm3: number;
    removed_volume_mm3: number;
    residual_volume_mm3: number;
    removal_error_pct: number;
    key_surfaces: SimulationReport["key_surfaces"];
    events: Array<{ kind: string; severity: string; message: string }>;
  };
  validation: {
    status: "PASS" | "WARN" | "FAIL";
    layers: Array<{ layer: string; status: string; checks: number }>;
  };
}

export function buildJobReport(input: { cam: CamIR; simulation: SimulationReport; nc: NcProgram; validation: ValidationReport }): JobReport {
  const { cam, simulation, nc, validation } = input;
  const toolById = new Map(seedTools.map((t) => [t.id, t]));
  const toolpaths = new Map((cam.toolpaths ?? []).map((tp) => [tp.operation_id, tp]));

  const toolOps = new Map<string, string[]>();
  for (const op of cam.operations) {
    const arr = toolOps.get(op.tool.tool_id) ?? [];
    arr.push(op.id);
    toolOps.set(op.tool.tool_id, arr);
  }

  return {
    schema_version: "1.0.0",
    part_id: cam.part_id,
    job_id: cam.job_id,
    ir_id: cam.ir_id,
    program_number: nc.program_number,
    status: validation.status === "FAIL" ? "FAIL" : simulation.status === "FAIL" ? "FAIL" : validation.status,
    validated: simulation.status === "PASS" && validation.status === "PASS",
    engine_version: cam.metadata?.generator_version ?? "0.1.0",
    generated_at: new Date().toISOString(),
    summary: {
      part_id: cam.part_id,
      machine: cam.machine.machine_name ?? cam.machine.machine_id,
      machine_id: cam.machine.machine_id,
      controller: cam.machine.controller_name ?? cam.machine.controller_id,
      controller_id: cam.machine.controller_id,
      axis_config: cam.machine.axis_config,
      material: cam.material.material_name ?? cam.material.material_id,
      material_id: cam.material.material_id,
      stock: { kind: cam.stock.kind, dimensions: cam.stock.dimensions ?? {} },
      operation_count: cam.operations.length,
      tool_count: cam.tools.length,
    },
    setup_sheet: cam.setups.map((s) => ({ setup_id: s.id, name: s.name, wcs: s.wcs, origin: s.origin })),
    tool_list: cam.tools.map((t) => {
      const tool = toolById.get(t.tool_id);
      return {
        tool_id: t.tool_id,
        tool_number: t.tool_number ?? 1,
        name: tool?.name ?? t.tool_id,
        type: tool?.type ?? "UNKNOWN",
        diameter_mm: tool?.diameter_mm ?? 0,
        operations: toolOps.get(t.tool_id) ?? [],
      };
    }),
    process_sheet: cam.operations.map((op) => {
      const tp = toolpaths.get(op.id);
      return {
        op_index: op.op_index,
        operation_id: op.id,
        type: op.type,
        name: op.name,
        tool_id: op.tool.tool_id,
        tool_number: op.tool.tool_number ?? 1,
        spindle_rpm: op.parameters.spindle_speed_rpm,
        feed_mm_min: op.parameters.feed_mm_min,
        stepdown_mm: op.parameters.stepdown_mm,
        coolant: op.parameters.coolant,
        move_count: tp?.moves.length ?? 0,
        feature_ids: op.feature_ids,
      };
    }),
    simulation: {
      status: simulation.status === "ERROR" ? "FAIL" : simulation.status,
      voxel_size_mm: simulation.voxel_size_mm,
      initial_volume_mm3: simulation.initial_volume_mm3,
      removed_volume_mm3: simulation.removed_volume_mm3,
      residual_volume_mm3: simulation.residual_volume_mm3,
      removal_error_pct: simulation.removal_error_pct,
      key_surfaces: simulation.key_surfaces,
      events: simulation.events.map((e) => ({ kind: e.kind, severity: e.severity, message: e.message })),
    },
    validation: {
      status: validation.status,
      layers: validation.layers.map((l) => ({ layer: l.layer, status: l.status, checks: l.checks.length })),
    },
  };
}
