/**
 * 切削参数引擎（P2-9）
 *
 * 确定性计算：Vc → RPM、fz → Feed、DOC/WOC（按刀具直径比例）、Plunge。
 * 约束层级：规则区间（RULE）→ 机床硬约束（MACHINE）→ 用户/AI 覆盖（USER）。
 * 策略：规则区间默认 clamp（可配置 reject）；机床硬约束超限 clamp；
 *       若 clamp 后低于规则下限则 reject（不可加工）。
 * 每个决策留痕（decisions[]），满足"排序/参数可解释、不突破硬约束"验收。
 */
import { ErrorCodes, type ErrorCode } from "@ai-cam/error-codes";
import { seedCuttingRules } from "@ai-cam/master-data";
import type { CuttingParameters, OperationType } from "@ai-cam/cam-ir";
import type { CuttingRule, Machine, Material, Tool } from "@ai-cam/domain-schemas";

export type ParameterName = "spindle_speed_rpm" | "feed_mm_min" | "plunge_feed_mm_min" | "stepdown_mm" | "stepover_mm";

export type DecisionAction = "APPROVED" | "CLAMPED" | "REJECTED";

export interface ConstraintDecision {
  parameter: ParameterName;
  requested: number;
  rule_min: number | null;
  rule_max: number | null;
  machine_max: number | null;
  action: DecisionAction;
  value: number;
  reason: string;
}

export interface ComputeParamsInput {
  tool: Pick<Tool, "id" | "type" | "diameter_mm" | "flute_count">;
  material: Pick<Material, "id" | "default_coolant">;
  opType: OperationType;
  machine?: Pick<Machine["kinematics"], "max_spindle_rpm" | "max_feed_mm_min">;
  /** 用户/AI 覆盖值（来源 USER）；未提供时由引擎按规则中值计算 */
  userOverrides?: Partial<CuttingParameters>;
  /** 规则集（默认主数据种子），用于测试注入 */
  rules?: CuttingRule[];
  /** 规则区间越界策略：clamp（默认）或 reject */
  rulePolicy?: "clamp" | "reject";
  /** 引擎版本（确定性复现） */
  engineVersion?: string;
}

export interface ComputeParamsResult {
  parameters: CuttingParameters;
  decisions: ConstraintDecision[];
  engine_version: string;
}

export const PARAMETER_ENGINE_VERSION = "0.1.0";

const mid = (a: number, b: number) => (a + b) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 刀具类型 → 规则表中的 tool_type 键 */
export function ruleToolType(toolType: Tool["type"]): string {
  return toolType;
}

export function findCuttingRule(
  materialId: string,
  toolType: Tool["type"],
  rules: CuttingRule[],
): CuttingRule | undefined {
  return rules.find((r) => r.material_id === materialId && r.tool_type === toolType);
}

/** 是否钻孔类工序（Plunge/DOC 语义不同，无需 stepover） */
export function isDrillOp(opType: OperationType): boolean {
  return opType === "DRILL";
}

/** 面铣/粗加工用更保守的轴向切深（浅层高频） */
export function docFactor(opType: OperationType): number {
  if (opType === "FACE") return 0.5; // 面铣取规则下限附近
  if (opType === "ADAPTIVE_ROUGH") return 0.75;
  return 1;
}

export function computeCuttingParameters(input: ComputeParamsInput): ComputeParamsResult {
  const rules = input.rules ?? seedCuttingRules;
  const rule = findCuttingRule(input.material.id, input.tool.type, rules);
  const decisions: ConstraintDecision[] = [];
  const D = input.tool.diameter_mm;
  const Z = input.tool.flute_count ?? 2;

  // 默认保守值（无规则时的兜底，来源 DEFAULT）
  const DEF = {
    vc: 60,
    fz: 0.03,
    docRatio: 0.5,
    wocRatio: 0.4,
    plungeFactor: 0.5,
  };

  // ---------- 1) 规则取值（中值） ----------
  let vc = DEF.vc;
  let fz = DEF.fz;
  let docRatio = DEF.docRatio;
  let wocRatio = DEF.wocRatio;
  if (rule) {
    vc = mid(rule.vc_range_m_min.min, rule.vc_range_m_min.max);
    fz = mid(rule.fz_range_mm.min, rule.fz_range_mm.max);
    docRatio = mid(rule.doc_ratio_recommended.min, rule.doc_ratio_recommended.max);
    wocRatio = mid(rule.woc_ratio_recommended.min, rule.woc_ratio_recommended.max);
  }

  // ---------- 2) 派生计算 ----------
  const rawRpm = rule ? (vc * 1000) / (Math.PI * D) : (DEF.vc * 1000) / (Math.PI * D);
  const rawFeed = fz * Z * rawRpm;
  const rawPlunge = rawFeed * DEF.plungeFactor;
  const rawDoc = (rule ? docRatio : DEF.docRatio) * D * docFactor(input.opType);
  const rawWoc = (rule ? wocRatio : DEF.wocRatio) * D;

  const machineMaxRpm = input.machine?.max_spindle_rpm ?? null;
  const machineMaxFeed = input.machine?.max_feed_mm_min ?? null;

  // ---------- 3) 规则区间 → clamp/reject ----------
  const ruleRpm = rule ? { min: (rule.vc_range_m_min.min * 1000) / (Math.PI * D), max: (rule.vc_range_m_min.max * 1000) / (Math.PI * D) } : null;
  const ruleFeed = rule ? { min: rule.fz_range_mm.min * Z * (rule.vc_range_m_min.min * 1000) / (Math.PI * D), max: rule.fz_range_mm.max * Z * (rule.vc_range_m_min.max * 1000) / (Math.PI * D) } : null;

  const applyRule = (name: ParameterName, value: number, rMin: number | null, rMax: number | null, mMax: number | null): number => {
    let v = value;
    let action: DecisionAction = "APPROVED";
    const notes: string[] = [];
    if (rMin != null && rMax != null && (v < rMin || v > rMax)) {
      if (input.rulePolicy === "reject") {
        decisions.push({ parameter: name, requested: value, rule_min: rMin, rule_max: rMax, machine_max: mMax, action: "REJECTED", value, reason: `超出规则区间 [${rMin.toFixed(2)}, ${rMax.toFixed(2)}]，策略为 reject` });
        return value;
      }
      v = clamp(v, rMin, rMax);
      action = "CLAMPED";
      notes.push(`规则区间 [${rMin.toFixed(2)}, ${rMax.toFixed(2)}]`);
    } else if (rMin != null && rMax != null) {
      notes.push("规则区间内");
    }
    // 机床硬约束：超上限 clamp（即使低于规则下限也按保守加工处理，不 reject）
    if (mMax != null && v > mMax) {
      v = Math.min(v, mMax);
      action = "CLAMPED";
      notes.push(rMin != null && v < rMin ? `机床上限 ${mMax}（clamp 后低于规则下限，保守加工）` : `机床上限 ${mMax}`);
    }
    decisions.push({ parameter: name, requested: value, rule_min: rMin, rule_max: rMax, machine_max: mMax, action, value: v, reason: notes.join("；") || "APPROVED" });
    return v;
  };

  // ---------- 4) 用户/AI 覆盖（USER）优先，仍受硬约束 ----------
  const usr = input.userOverrides;
  const spindle = usr?.spindle_speed_rpm != null ? applyRule("spindle_speed_rpm", usr.spindle_speed_rpm, ruleRpm?.min ?? null, ruleRpm?.max ?? null, machineMaxRpm) : applyRule("spindle_speed_rpm", rawRpm, ruleRpm?.min ?? null, ruleRpm?.max ?? null, machineMaxRpm);
  const feed = usr?.feed_mm_min != null ? applyRule("feed_mm_min", usr.feed_mm_min, ruleFeed?.min ?? null, ruleFeed?.max ?? null, machineMaxFeed) : applyRule("feed_mm_min", rawFeed, ruleFeed?.min ?? null, ruleFeed?.max ?? null, machineMaxFeed);
  const plunge = usr?.plunge_feed_mm_min != null ? applyRule("plunge_feed_mm_min", usr.plunge_feed_mm_min, null, null, machineMaxFeed) : applyRule("plunge_feed_mm_min", rawPlunge, null, null, machineMaxFeed);
  const stepdown = usr?.stepdown_mm != null ? applyRule("stepdown_mm", usr.stepdown_mm, null, null, null) : applyRule("stepdown_mm", rawDoc, null, null, null);
  const stepover = usr?.stepover_mm != null ? applyRule("stepover_mm", usr.stepover_mm, null, null, null) : applyRule("stepover_mm", rawWoc, null, null, null);

  const rejected = decisions.some((d) => d.action === "REJECTED");
  if (rejected) {
    throw new ParameterConstraintError(decisions);
  }

  const source: CuttingParameters["source"] = usr && Object.keys(usr).length > 0 ? "USER" : rule ? "ENGINE" : "DEFAULT";
  const coolant: CuttingParameters["coolant"] = usr?.coolant ?? mapCoolant(input.material.default_coolant);

  const parameters: CuttingParameters = {
    spindle_speed_rpm: Math.round(spindle),
    feed_mm_min: Math.round(feed),
    plunge_feed_mm_min: Math.round(plunge),
    stepdown_mm: round2(stepdown),
    stepover_mm: isDrillOp(input.opType) ? undefined : round2(stepover),
    coolant,
    source,
  };

  return {
    parameters,
    decisions,
    engine_version: input.engineVersion ?? PARAMETER_ENGINE_VERSION,
  };
}

/** 材料默认冷却 → CAM IR 枚举（DRY 等域内值映射为 OFF） */
export function mapCoolant(c: string | undefined): CuttingParameters["coolant"] {
  const v = (c ?? "FLOOD").toUpperCase();
  if (v === "FLOOD" || v === "MIST" || v === "THROUGH" || v === "OFF") return v;
  return "OFF"; // DRY / 其他 → OFF
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export class ParameterConstraintError extends Error {
  readonly code: ErrorCode = ErrorCodes.CAM_PARAMETER_OUT_OF_RANGE;
  decisions: ConstraintDecision[];
  constructor(decisions: ConstraintDecision[]) {
    super(`参数约束不可满足：${decisions.filter((d) => d.action === "REJECTED").map((d) => `${d.parameter}=${d.requested.toFixed(1)}`).join(", ")}`);
    this.name = "ParameterConstraintError";
    this.decisions = decisions;
  }
}
