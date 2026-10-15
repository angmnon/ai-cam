/**
 * Replan Loop（P4-8）：失败 → 错误提取 → 意图调整 → 重跑，上限 3 次；超限转人工。
 */
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import type { Feature } from "@ai-cam/domain-schemas";
import type { PlannerOutput } from "./guardrails.js";
import { runCamAgent, type AgentRun, type AgentOptions } from "./agent.js";

export const MAX_REPLANS = 3;

export interface ExtractedFailure {
  layer: string;
  code: string;
  message: string;
}

/** 从 Job 结果提取可操作失败（仿真事件 + 校验分层失败 + pipeline 失败） */
export function extractFailures(job: AgentRun["job"]): ExtractedFailure[] {
  const out: ExtractedFailure[] = [];
  for (const e of job.simulation.events) {
    out.push({ layer: "SIMULATION", code: e.kind, message: e.message });
  }
  for (const l of job.validation?.layers ?? []) {
    if (l.status === "FAIL") {
      for (const c of l.checks) {
        if (c.severity === "ERROR" || l.status === "FAIL") out.push({ layer: `VALIDATION_${l.layer}`, code: c.code, message: c.message });
      }
    }
  }
  for (const p of job.pipeline) {
    if (p.status === "FAIL") out.push({ layer: "PIPELINE", code: p.stage, message: p.detail });
  }
  return out;
}

/** 失败 → 意图补丁（确定性策略调整） */
export function adjustIntentForFailures(base: PlannerOutput | null, failures: ExtractedFailure[]): PlannerOutput {
  const intent: PlannerOutput = base ?? {
    strategy: "rough_then_finish",
    setup_preference: "single_side_z",
    process_order: "DEFAULT",
    tool_weights: { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 },
  };
  const overrides = { ...(intent.overrides ?? {}) };
  for (const f of failures) {
    if (f.code === "RESIDUAL_FAIL" || f.code === "RESIDUAL_WARN") {
      // 残料超标 → 减小步深/步距
      overrides.stepdown_mm = Math.max(0.1, (overrides.stepdown_mm ?? 2.0) / 2);
      overrides.stepover_mm = Math.max(0.1, (overrides.stepover_mm ?? 0.6) * 0.7);
    } else if (f.code === "COLLISION" || f.code === "GOUGE") {
      // 碰撞/过切 → 保守加工（小步深 + 表面优先）
      intent.strategy = "finish_priority";
      overrides.stepdown_mm = Math.max(0.1, (overrides.stepdown_mm ?? 2.0) / 2);
    } else if (f.layer.startsWith("VALIDATION_") && f.code === "NC_SEMANTIC") {
      intent.strategy = "finish_priority";
    }
  }
  return { ...intent, overrides };
}

export interface ReplanResult {
  attempts: number;
  human_review: boolean;
  failures: ExtractedFailure[];
  runs: AgentRun[];
}

export async function runWithReplan(part: NormalizedPartModel, features: Feature[], options: AgentOptions & { maxReplans?: number }): Promise<ReplanResult> {
  const maxReplans = options.maxReplans ?? MAX_REPLANS;
  const runs: AgentRun[] = [];
  // P1-15：跨轮跟踪上一轮真实意图，供 adjustIntentForFailures 生成补丁
  let prevIntent: PlannerOutput | null = null;

  for (let i = 0; i <= maxReplans; i += 1) {
    const prevFailures = i === 0 ? [] : extractFailures(runs[runs.length - 1].job);
    // 每轮把上轮真实失败喂给 adjustIntentForFailures，补丁作为下一轮 intent（首轮走 LLM）
    const patchedIntent = i === 0 ? undefined : adjustIntentForFailures(prevIntent, prevFailures);
    const run = await runCamAgent(part, features, {
      ...options,
      goal: i === 0 ? options.goal : `${options.goal}；上一轮失败：${prevFailures.map((f) => `${f.code}:${f.message}`).join("；")}`,
      intentOverride: patchedIntent,
    });
    runs.push(run);
    prevIntent = run.intent;
    const failures = extractFailures(run.job);
    if (failures.length === 0) {
      return { attempts: i + 1, human_review: false, failures: [], runs };
    }
    if (i === maxReplans) {
      return { attempts: i + 1, human_review: true, failures, runs };
    }
  }
  return { attempts: maxReplans + 1, human_review: true, failures: [], runs };
}
