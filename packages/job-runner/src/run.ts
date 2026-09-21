/**
 * Job 端到端编排（P3-8）：plan → sim → post → validate 一键生成 Validated NC。
 * 确定性流水线；任一环节失败抛出带阶段的错误。
 * P1-11 双门禁严格化：NC_READY = Simulation PASS AND No Critical Warning AND Validator PASS。
 * P1-12 仿真 FAIL 短路：仿真 FAIL 立即阻断 POST/VALIDATE，不生成 NC。
 */
import type { CamIR } from "@ai-cam/cam-ir";
import { planPart } from "@ai-cam/cam-kernel";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import type { FeatureGraph } from "@ai-cam/domain-schemas";
import { simulate, type SimulationReport } from "@ai-cam/stock-sim";
import {postProcess, type NcProgram, makeProfile} from "@ai-cam/post-core";
import { validateNc, type ValidationReport } from "@ai-cam/nc-validator";

export const JOB_RUNNER_VERSION = "0.1.0";

/** 流水线阶段状态；SKIPPED 表示因上游失败被阻断/未执行 */
export type PipelineStatus = "PASS" | "WARN" | "FAIL" | "SKIPPED";

export interface JobResult {
  cam: CamIR;
  simulation: SimulationReport;
  /** 仿真 FAIL 短路时为 null（未生成 NC） */
  nc: NcProgram | null;
  /** 仿真 FAIL 短路时为 null（未执行 VALIDATE 阶段） */
  validation: ValidationReport | null;
  pipeline: Array<{ stage: string; status: PipelineStatus; detail: string }>;
  /** P1-11 严格双门禁：仿真与校验均为 PASS 才放行；WARN/FAIL 均不放行 */
  validated: boolean;
  /** 流水线被阻断或未放行的原因（仿真 FAIL / 存在 WARN 等） */
  reason?: string;
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

  // P1-12：仿真 FAIL 短路 —— 不做 POST/VALIDATE 阶段，直接返回未放行结果。
  if (simulation.status === "FAIL") {
    const failReasons = simulation.events.filter((e) => e.severity === "FAIL").map((e) => e.message).join("; ") || "仿真未通过";
    pipeline.push({ stage: "POST", status: "SKIPPED", detail: `仿真 FAIL（${simulation.events.filter((e) => e.severity === "FAIL").map((e) => e.kind).join(", ") || "FAIL"}），POST 阶段被阻断` });
    pipeline.push({ stage: "VALIDATE", status: "SKIPPED", detail: "仿真 FAIL，VALIDATE 阶段被阻断" });
    return {
      cam,
      simulation,
      nc: null,
      validation: null,
      pipeline,
      validated: false,
      reason: `仿真 FAIL，POST/VALIDATE 已阻断：${failReasons}`,
    };
  }

  // 3. post（post-core）
  const profile = makeProfile(input.dialect ?? "FANUC");
  const nc = postProcess(cam, profile);
  pipeline.push({ stage: "POST", status: "PASS", detail: `${nc.program_number} / ${nc.lines.length} 行 / ${nc.metadata.tool_changes} 次换刀` });

  // 4. validate（nc-validator 四层）
  const validation = validateNc({ cam, ncText: nc.text, programNumber: nc.program_number, simulation });
  pipeline.push({ stage: "VALIDATE", status: validation.status, detail: validation.layers.map((l) => `${l.layer}=${l.status}`).join(" ") });

  // P1-11 严格双门禁：仅仿真 PASS 且校验 PASS 才 validated；WARN/FAIL 均不放行
  const validated = simulation.status === "PASS" && validation.status === "PASS";
  return {
    cam,
    simulation,
    nc,
    validation,
    pipeline,
    validated,
    reason: validated ? undefined : `未达 NC_READY（仿真=${simulation.status} / 校验=${validation.status}）`,
  };
}
