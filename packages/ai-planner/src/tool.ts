/**
 * Tool Planner（P4-7）：候选生成 + 加权评分 + 用户倾向权重，选择可解释。
 */
import type { Tool } from "@ai-cam/domain-schemas";
import type { Operation } from "@ai-cam/cam-ir";

export interface ToolWeights {
  diameter_match: number;
  tool_cost: number;
  surface_quality: number;
}

export interface ToolPlanResult {
  tool: Tool;
  rank: number;
  rank_reason: string[];
  score: number;
  candidates: Array<{ tool: Tool; score: number; reasons: string[] }>;
  /** P3-25：输入权重是否发生了归一化/回退（调用方据此知晓 clamp 发生） */
  weights_clamped: boolean;
}

const DEFAULT_WEIGHTS: ToolWeights = { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 };
/** P3-25：权重和下限——sum <= 此阈值视为退化输入，回退默认权重 */
const MIN_WEIGHT_SUM = 0;
/** P3-25：浮点容差，用于判定权重和是否已归一化为 1 */
const WEIGHTS_SUM_EPS = 1e-9;

export interface ClampedWeights {
  weights: ToolWeights;
  /** 输入被归一化（sum≠1）或回退为默认（sum≤0）时为 true */
  clamped: boolean;
}

export function clampWeights(w: ToolWeights): ClampedWeights {
  const sum = w.diameter_match + w.tool_cost + w.surface_quality;
  if (sum <= MIN_WEIGHT_SUM) return { weights: DEFAULT_WEIGHTS, clamped: true };
  const weights = { diameter_match: w.diameter_match / sum, tool_cost: w.tool_cost / sum, surface_quality: w.surface_quality / sum };
  const clamped = Math.abs(sum - 1) > WEIGHTS_SUM_EPS;
  return { weights, clamped };
}

/** 候选：库存>0，且类型/直径满足工序约束 */
export function toolCandidates(opType: Operation["type"], constraint: { maxDiameter?: number; preferDrillOf?: number }, tools: Tool[]): Tool[] {
  const inStock = tools.filter((t) => t.stock_qty > 0);
  if (opType === "DRILL" && constraint.preferDrillOf != null) {
    return inStock.filter((t) => t.type === "DRILL");
  }
  const maxDia = constraint.maxDiameter ?? 8;
  return inStock.filter((t) => t.type === "FLAT_END_MILL" && t.diameter_mm <= maxDia + 1e-9);
}

export function planTool(opType: Operation["type"], constraint: { maxDiameter?: number; preferDrillOf?: number }, tools: Tool[], weights: ToolWeights = DEFAULT_WEIGHTS): ToolPlanResult {
  const { weights: w, clamped: weights_clamped } = clampWeights(weights);
  const candidates = toolCandidates(opType, constraint, tools);
  if (candidates.length === 0) {
    // 兜底：任意库存平刀/钻头（保持可解释）
    const fallback = tools.filter((t) => t.stock_qty > 0 && (opType === "DRILL" ? t.type === "DRILL" : t.type === "FLAT_END_MILL"));
    if (fallback.length === 0) throw new Error(`no tool for ${opType}`);
    const t = fallback.sort((a, b) => a.diameter_mm - b.diameter_mm)[0];
    return { tool: t, rank: 1, rank_reason: ["无满足约束候选，最小直径兜底"], score: 0, candidates: [], weights_clamped };
  }

  const target = constraint.preferDrillOf ?? constraint.maxDiameter ?? 8;
  const scored = candidates.map((t) => {
    const reasons: string[] = [];
    // 直径匹配：|d - target| 越小越好
    const matchErr = Math.abs(t.diameter_mm - target);
    const dm = matchErr <= 1.5 ? 1 : Math.max(0, 1 - matchErr / 8);
    reasons.push(`直径 ${t.diameter_mm}mm vs 目标 ${target}mm → 匹配度 ${dm.toFixed(2)}`);
    // 成本：直径小/通用型权重低（v1 简化：直径越大成本越高）
    const cost = Math.max(0, 1 - t.diameter_mm / 16);
    reasons.push(`成本因子 ${cost.toFixed(2)}（越大越便宜）`);
    // 表面质量：小直径平刀 / 球刀质量好（v1：直径越小表面细节越好）
    const sq = Math.max(0, 1 - t.diameter_mm / 12);
    reasons.push(`表面质量因子 ${sq.toFixed(2)}`);
    const score = w.diameter_match * dm + w.tool_cost * cost + w.surface_quality * sq;
    reasons.push(`加权评分 ${score.toFixed(3)}（match ${w.diameter_match} / cost ${w.tool_cost} / quality ${w.surface_quality}）`);
    return { tool: t, score, reasons };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return {
    tool: best.tool,
    rank: 1,
    rank_reason: best.reasons,
    score: best.score,
    candidates: scored.slice(0, 5),
    weights_clamped,
  };
}
