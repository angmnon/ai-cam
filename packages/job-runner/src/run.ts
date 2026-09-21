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
import { createJobStatusMachine, type JobStatus } from "./job-status.js";

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
  /** P2-30 Job 状态机终态：成功链路 RELEASED / 失败链路 FAILED / 完成但未放行 VALIDATED */
  status: JobStatus;
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
  // P2-30 Job 状态机：初始 PENDING，每完成一个阶段推进；非法迁移抛错。
  const sm = createJobStatusMachine();

  // 1. plan（cam-kernel）
  const { cam, parameterDecisions } = planPart(input.part, input.features);
  pipeline.push({ stage: "PLAN", status: "PASS", detail: `${cam.operations.length} ops / ${cam.toolpaths?.reduce((a, t) => a + t.moves.length, 0) ?? 0} moves / ${parameterDecisions.length} 参数决策` });
  sm.advance("PLANNED");

  // 2. simulate（stock-sim）
  const simulation = simulate({ cam, partVolumeMm3: input.part.volume_mm3, thresholds: input.simulationThresholds, frameStep: input.frameStep ?? 4 });
  pipeline.push({ stage: "SIMULATE", status: simulation.status === "ERROR" ? "FAIL" : simulation.status, detail: `切除 ${simulation.removed_volume_mm3}mm³ / 残料 ${simulation.residual_volume_mm3}mm³ / ${simulation.events.length} 事件` });

  // P1-12：仿真 FAIL 短路 —— 不做 POST/VALIDATE 阶段，直接返回未放行结果。
  if (simulation.status === "FAIL") {
    const failReasons = simulation.events.filter((e) => e.severity === "FAIL").map((e) => e.message).join("; ") || "仿真未通过";
    pipeline.push({ stage: "POST", status: "SKIPPED", detail: `仿真 FAIL（${simulation.events.filter((e) => e.severity === "FAIL").map((e) => e.kind).join(", ") || "FAIL"}），POST 阶段被阻断` });
    pipeline.push({ stage: "VALIDATE", status: "SKIPPED", detail: "仿真 FAIL，VALIDATE 阶段被阻断" });
    sm.advance("FAILED");
    return {
      cam,
      simulation,
      nc: null,
      validation: null,
      pipeline,
      validated: false,
      reason: `仿真 FAIL，POST/VALIDATE 已阻断：${failReasons}`,
      status: sm.current,
    };
  }
  sm.advance("SIMULATED");

  // 3. post（post-core）
  const profile = makeProfile(input.dialect ?? "FANUC");
  const nc = postProcess(cam, profile);

  // P2-29：POST 阶段真实校验 —— NC 文本非空且至少含 1 行非空，否则 POST=FAIL 并短路 VALIDATE。
  const postNonEmptyLines = nc.lines.filter((l) => l.trim().length > 0);
  const postOk = nc.text.trim().length > 0 && postNonEmptyLines.length > 0;
  if (!postOk) {
    pipeline.push({ stage: "POST", status: "FAIL", detail: `post 输出为空（text 长度=${nc.text.length} / ${nc.lines.length} 行 / 非空 ${postNonEmptyLines.length} 行）` });
    pipeline.push({ stage: "VALIDATE", status: "SKIPPED", detail: "POST 输出为空，VALIDATE 阶段被阻断" });
    sm.advance("FAILED");
    return {
      cam,
      simulation,
      nc,
      validation: null,
      pipeline,
      validated: false,
      reason: `POST 阶段失败：NC 文本为空（post 输出 ${nc.lines.length} 行 / 非空 ${postNonEmptyLines.length} 行）`,
      status: sm.current,
    };
  }
  pipeline.push({ stage: "POST", status: "PASS", detail: `${nc.program_number} / ${nc.lines.length} 行 / ${nc.metadata.tool_changes} 次换刀` });
  sm.advance("POSTED");

  // 4. validate（nc-validator 四层）
  const validation = validateNc({ cam, ncText: nc.text, programNumber: nc.program_number, simulation });
  pipeline.push({ stage: "VALIDATE", status: validation.status, detail: validation.layers.map((l) => `${l.layer}=${l.status}`).join(" ") });
  sm.advance("VALIDATED");

  // P1-11 严格双门禁：仅仿真 PASS 且校验 PASS 才 validated；WARN/FAIL 均不放行
  const validated = simulation.status === "PASS" && validation.status === "PASS";
  // 双门禁全过 → 放行 RELEASED；否则停留在 VALIDATED（未放行但未失败）
  if (validated) sm.advance("RELEASED");
  return {
    cam,
    simulation,
    nc,
    validation,
    pipeline,
    validated,
    reason: validated ? undefined : `未达 NC_READY（仿真=${simulation.status} / 校验=${validation.status}）`,
    status: sm.current,
  };
}
