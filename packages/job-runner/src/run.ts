/**
 * Job 端到端编排（P3-8）：plan → sim → post → validate 一键生成 Validated NC。
 * 确定性流水线；任一环节失败抛出带阶段的错误。
 */
import type { CamIR } from "@ai-cam/cam-ir";
import { planPart } from "@ai-cam/cam-kernel";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import type { FeatureGraph } from "@ai-cam/domain-schemas";
import { simulate, type SimulationReport } from "@ai-cam/stock-sim";
import {postProcess, type NcProgram, makeProfile} from "@ai-cam/post-core";
import { validateNc, type ValidationReport } from "@ai-cam/nc-validator";

export const JOB_RUNNER_VERSION = "0.1.0";

export interface JobResult {
  cam: CamIR;
  simulation: SimulationReport;
  nc: NcProgram;
  validation: ValidationReport;
  pipeline: Array<{ stage: string; status: "PASS" | "WARN" | "FAIL"; detail: string }>;
  validated: boolean;
}

export interface RunJobInput {
  part: NormalizedPartModel;
  partName: string;
  features: FeatureGraph["features"];
  dialect?: "FANUC" | "SYNTEC" | "MITSUBISHI" | "ISO_GENERIC";
  simulationThresholds?: Parameters<typeof simulate>[0]["thresholds"];
  frameStep?: number;
}

export function runJob(input: RunJobInput): JobResult {
  const pipeline: JobResult["pipeline"] = [];

  // 1. plan（cam-kernel）
  const { cam, parameterDecisions } = planPart(input.part, input.features);
  pipeline.push({ stage: "PLAN", status: "PASS", detail: `${cam.operations.length} ops / ${cam.toolpaths?.reduce((a, t) => a + t.moves.length, 0) ?? 0} moves / ${parameterDecisions.length} 参数决策` });

  // 2. simulate（stock-sim）
  const simulation = simulate({ cam, partVolumeMm3: input.part.volume_mm3, thresholds: input.simulationThresholds, frameStep: input.frameStep ?? 4 });
  pipeline.push({ stage: "SIMULATE", status: simulation.status, detail: `切除 ${simulation.removed_volume_mm3}mm³ / 残料 ${simulation.residual_volume_mm3}mm³ / ${simulation.events.length} 事件` });

  // 3. post（post-core）
  const profile = makeProfile(input.dialect ?? "FANUC");
  const nc = postProcess(cam, profile);
  pipeline.push({ stage: "POST", status: "PASS", detail: `${nc.program_number} / ${nc.lines.length} 行 / ${nc.metadata.tool_changes} 次换刀` });

  // 4. validate（nc-validator 四层）
  const validation = validateNc({ cam, ncText: nc.text, programNumber: nc.program_number, simulation });
  pipeline.push({ stage: "VALIDATE", status: validation.status, detail: validation.layers.map((l) => `${l.layer}=${l.status}`).join(" ") });

  const validated = simulation.status !== "FAIL" && validation.status !== "FAIL";
  return { cam, simulation, nc, validation, pipeline, validated };
}
