/**
 * Process Planner（P4-6）：Operation 类型顺序 DAG + 依赖规则 DSL + Topological Sort。
 * 违反依赖的排序被拒绝（不静默修正）。
 */
import type { Feature } from "@ai-cam/domain-schemas";
import type { Operation } from "@ai-cam/cam-ir";
import { ProcessOrderSchema, type ProcessOrder } from "./guardrails.js";

export type OpType = Operation["type"];

/** 依赖规则 DSL：ifType 存在时，mustFollow 类型必须在其之前、mustPrecede 类型必须在其之后 */
export interface ProcessRule {
  ifType: OpType;
  mustFollow?: OpType[];
  mustPrecede?: OpType[];
  reason: string;
}

export const PROCESS_RULES: ProcessRule[] = [
  { ifType: "FACE", mustFollow: [], mustPrecede: ["POCKET", "DRILL", "CONTOUR", "CHAMFER"], reason: "顶面清面必须先于所有开腔/钻孔/轮廓加工" },
  { ifType: "POCKET", mustFollow: ["FACE"], mustPrecede: ["CHAMFER"], reason: "型腔粗加工在清面后、倒角前" },
  { ifType: "DRILL", mustFollow: ["FACE"], mustPrecede: ["CHAMFER"], reason: "钻孔在清面后、倒角前（避免毛刺影响倒角）" },
  { ifType: "CHAMFER", mustFollow: ["FACE", "POCKET", "DRILL"], mustPrecede: [], reason: "倒角在孔/腔完成后最后做" },
  { ifType: "CONTOUR", mustFollow: ["FACE"], mustPrecede: [], reason: "轮廓精加工在清面后" },
];

export interface ProcessPlan {
  order: OpType[];
  /** 特征 → 期望类型映射（供 cam-kernel 装配） */
  feature_types: Array<{ feature_id: string; op_type: OpType }>;
  reasons: string[];
  validation: { ok: boolean; errors: string[] };
}

/** 由特征推导 op 类型（与 cam-kernel planner 的装配规则一致） */
export function opTypeOfFeature(f: Feature): OpType {
  switch (f.type) {
    case "OUTER_PROFILE":
      return "FACE";
    case "POCKET":
    case "SLOT":
    case "OPEN_POCKET":
      return "POCKET";
    case "HOLE_THROUGH":
    case "HOLE_BLIND":
      return "DRILL";
    case "BOSS":
    case "STEP":
      return "CONTOUR";
    case "CHAMFER":
      return "CHAMFER";
    default:
      return "CONTOUR";
  }
}

/** 校验给定顺序是否满足依赖规则（Topological 一致性检查） */
export function validateOrder(order: OpType[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const pos = new Map(order.map((t, i) => [t, i]));
  for (const rule of PROCESS_RULES) {
    if (!order.includes(rule.ifType)) continue;
    const p = pos.get(rule.ifType)!;
    for (const before of rule.mustFollow ?? []) {
      if (order.includes(before) && pos.get(before)! > p) errors.push(`${rule.ifType} 必须在 ${before} 之后（${rule.reason}）`);
    }
    for (const after of rule.mustPrecede ?? []) {
      if (order.includes(after) && pos.get(after)! < p) errors.push(`${rule.ifType} 必须在 ${after} 之前（${rule.reason}）`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface ProcessPlanOptions {
  preference?: ProcessOrder;
  /** 追加外轮廓精修（cam-kernel 默认行为） */
  withOuterFinish?: boolean;
}

export function planProcess(features: Feature[], options: ProcessPlanOptions = {}): ProcessPlan {
  const preference = ProcessOrderSchema.parse(options.preference ?? "DEFAULT");
  const mapping = features.map((f) => ({ feature_id: f.id, op_type: opTypeOfFeature(f) }));
  const types = [...new Set(mapping.map((m) => m.op_type))];
  const reasons: string[] = [];

  // 拓扑排序：先按规则 DAG，再用 preference 微调
  let order = [...types];
  const rank = (t: OpType): number => {
    if (t === "FACE") return 0;
    if (t === "POCKET" || t === "DRILL") return 1;
    if (t === "CONTOUR") return 2;
    if (t === "CHAMFER") return 3;
    return 2;
  };
  order.sort((a, b) => rank(a) - rank(b));

  if (preference === "FACE_FIRST" && order[0] !== "FACE") {
    order = ["FACE", ...order.filter((t) => t !== "FACE")];
    reasons.push("偏好 FACE_FIRST：顶面清面置顶");
  }
  if (preference === "DRILL_LAST" && order.includes("DRILL")) {
    order = [...order.filter((t) => t !== "DRILL"), "DRILL"];
    reasons.push("偏好 DRILL_LAST：钻孔移到末段");
  }

  let validation = validateOrder(order);
  if (!validation.ok) {
    // 偏好与规则冲突 → 拒绝并回退规则顺序（violation 保留给上层）
    order = [...types].sort((a, b) => rank(a) - rank(b));
    // P2-36：回退后必须重跑 validation，保证返回的 validation.ok 与最新 order 自洽
    validation = validateOrder(order);
    reasons.push("偏好与依赖规则冲突：已回退到规则默认顺序");
  }

  if (options.withOuterFinish && !order.includes("CONTOUR")) {
    order.push("CONTOUR");
    mapping.push({ feature_id: "part_profile", op_type: "CONTOUR" });
    reasons.push("追加外轮廓精修 CONTOUR_OUTER");
  }

  return { order, feature_types: mapping, reasons, validation };
}
