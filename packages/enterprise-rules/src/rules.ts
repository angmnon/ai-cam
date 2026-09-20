/**
 * 企业规则引擎（P5-4）：声明式规则 DSL + 优先级折叠。
 *
 * 优先级（低 → 高）：AI 优化 < 工具约束 < 材料规则 < 企业规则。
 * 同一参数被多条规则命中时，高优先级规则覆盖低优先级，并记录决策链（可解释）。
 */
import type { CuttingParameters } from "@ai-cam/cam-ir";

export type RuleScope = "ENTERPRISE" | "MATERIAL" | "TOOL" | "AI";
/** 数值型参数覆盖：绝对限值或乘数 */
export interface NumericClause {
  param: keyof Pick<CuttingParameters, "spindle_speed_rpm" | "feed_mm_min" | "stepdown_mm" | "stepover_mm" | "ramp_angle_deg" | "plunge_feed_mm_min">;
  /** clamp 模式：abs 直接取值 / max 取上限 / min 取下限 */
  mode: "abs" | "max" | "min";
  value: number;
}
export type RuleClause =
  | { kind: "numeric"; numeric: NumericClause }
  | { kind: "coolant"; coolant: CuttingParameters["coolant"] }
  | { kind: "forbid_tool_type"; tool_types: string[] };

export interface EnterpriseRule {
  id: string;
  name: string;
  scope: RuleScope;
  /** 适用范围：特征类型（缺省=全部） */
  applies_to_features: string[];
  /** 适用材料族（缺省=全部） */
  applies_to_material?: string[];
  /** 适用刀具类型（缺省=全部） */
  applies_to_tools?: string[];
  clauses: RuleClause[];
  enabled: boolean;
  note?: string;
}

export interface RuleContext {
  featureType: string;
  materialFamily: string;
  toolType: string;
  toolDiameterMm?: number;
}

export interface RuleDecision {
  rule_id: string;
  rule_name: string;
  scope: RuleScope;
  clause_desc: string;
  effect: string;
}

export interface RuleEvaluation {
  params: Partial<CuttingParameters>;
  /** 决策链：被应用的规则按优先级从低到高排列，最后者胜出 */
  decisions: RuleDecision[];
  /** 被规则命中但被更高优先级覆盖的规则 */
  overridden: RuleDecision[];
}

export const RULE_PRIORITY: Record<RuleScope, number> = { AI: 1, TOOL: 2, MATERIAL: 3, ENTERPRISE: 4 };

export function matches(ctx: RuleContext, rule: EnterpriseRule): boolean {
  if (!rule.enabled) return false;
  if (rule.applies_to_features.length > 0 && !rule.applies_to_features.includes(ctx.featureType)) return false;
  if (rule.applies_to_material && rule.applies_to_material.length > 0 && !rule.applies_to_material.includes(ctx.materialFamily)) return false;
  if (rule.applies_to_tools && rule.applies_to_tools.length > 0 && !rule.applies_to_tools.includes(ctx.toolType)) return false;
  return true;
}

export function applyClause(params: Partial<CuttingParameters>, c: RuleClause, ctx: RuleContext): { effect: string } {
  if (c.kind === "coolant") {
    params.coolant = c.coolant;
    return { effect: `冷却 ${c.coolant}` };
  }
  if (c.kind === "forbid_tool_type") {
    // 禁刀：命中即抛错（调用方处理为不可用刀具）
    throw new ForbiddenToolError(c.tool_types, ctx.toolType);
  }
  const { param, mode, value } = c.numeric;
  const cur = (params[param] as number | undefined) ?? value;
  let next = cur;
  if (mode === "abs") next = value;
  else if (mode === "max") next = Math.min(cur, value);
  else next = Math.max(cur, value);
  params[param] = next;
  return { effect: `${param} ${mode}=${value}（原 ${cur} → ${next}）` };
}

export class ForbiddenToolError extends Error {
  constructor(public forbiddenTypes: string[], public toolType: string) {
    super(`禁刀规则命中：不允许 ${forbiddenTypes.join("/")} 用于当前上下文（当前刀具 ${toolType}）`);
  }
}

/** 规则求值：按优先级升序应用，高优先级覆盖低优先级 */
export function evaluateRules(rules: EnterpriseRule[], ctx: RuleContext, base: Partial<CuttingParameters> = {}): RuleEvaluation {
  const params: Partial<CuttingParameters> = { ...base };
  const decisions: RuleDecision[] = [];
  const overridden: RuleDecision[] = [];
  const sorted = [...rules].sort((a, b) => RULE_PRIORITY[a.scope] - RULE_PRIORITY[b.scope]);
  for (const rule of sorted) {
    if (!matches(ctx, rule)) continue;
    const applied: RuleDecision[] = [];
    let blocked = false;
    for (const clause of rule.clauses) {
      try {
        const { effect } = applyClause(params, clause, ctx);
        applied.push({ rule_id: rule.id, rule_name: rule.name, scope: rule.scope, clause_desc: describeClause(clause), effect });
      } catch (e) {
        if (e instanceof ForbiddenToolError) {
          overridden.push({ rule_id: rule.id, rule_name: rule.name, scope: rule.scope, clause_desc: `禁刀 ${e.forbiddenTypes.join("/")}`, effect: "禁刀（终止）" });
          blocked = true;
          break;
        }
        throw e;
      }
    }
    if (blocked) continue;
    decisions.push(...applied);
  }
  // 同参数多规则命中：最后（最高优先级）者胜出——将较早的被覆盖者移入 overridden 说明
  const seen = new Map<string, RuleDecision>();
  const overtaken: RuleDecision[] = [];
  for (const d of decisions) {
    const key = paramKey(d);
    if (seen.has(key)) overtaken.push(seen.get(key)!);
    seen.set(key, d);
  }
  return { params, decisions: [...seen.values()], overridden: [...overridden, ...overtaken] };
}

function paramKey(d: RuleDecision): string {
  const m = d.clause_desc.match(/^[a-z_]+/);
  return m ? m[0] : d.clause_desc;
}

function describeClause(c: RuleClause): string {
  if (c.kind === "coolant") return `coolant=${c.coolant}`;
  if (c.kind === "forbid_tool_type") return `forbid:${c.tool_types.join("|")}`;
  return `${c.numeric.param}.${c.numeric.mode}=${c.numeric.value}`;
}
