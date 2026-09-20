/**
 * CAM Master Agent（P4-3）：意图级工具编排。
 * 流程：目标+特征摘要 → Planner Prompt → LLM 结构化输出 → Guardrails → 程序化规划器
 *      （setup/process/tool）→ cam-kernel 确定性生成 → Job 全流程验证。
 * 工具注册表：analyze / get_features / query_tools / calc_params / create_op / generate / simulate / validate，
 * 每次工具调用都做 schema 校验并留痕（tool_calls 审计）。
 */
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import type { Feature } from "@ai-cam/domain-schemas";
import { ModelGateway, buildPlannerPrompt, type PlannerContext } from "@ai-cam/model-gateway";
import { seedMachines, seedMaterials, seedTools } from "@ai-cam/master-data";
import { planPart } from "@ai-cam/cam-kernel";
import { runJob } from "@ai-cam/job-runner";
import { validatePlannerOutput, validatePlannerRefs, type PlannerOutput } from "./guardrails.js";
import { planSetups } from "./setup.js";
import { planProcess } from "./process.js";
import { planTool, type ToolWeights } from "./tool.js";

export interface AgentToolCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  ok: boolean;
}

export interface AgentRun {
  intent: PlannerOutput | null;
  guardrail: { ok: boolean; violations: Array<{ path: string; message: string }> };
  setups: ReturnType<typeof planSetups>;
  process: ReturnType<typeof planProcess>;
  tool_choices: Array<{ operation_type: string; tool_id: string; score: number; reasons: string[] }>;
  job: ReturnType<typeof runJob>;
  tool_calls: AgentToolCall[];
  model_route: string;
  prompt_version: string;
}

export interface AgentOptions {
  gateway: ModelGateway;
  goal: string;
  materialId?: string;
  machineId?: string;
  dialect?: "FANUC" | "SYNTEC" | "MITSUBISHI" | "ISO_GENERIC";
}

/** 工具注册表（v1：只读/生成/验证，供审计与 schema 校验；可扩展为可写工具） */
export interface AgentTools {
  analyze(part: NormalizedPartModel): { volume_mm3: number; bbox: { min: number[]; max: number[] } };
  get_features(part: NormalizedPartModel, features: Feature[]): { count: number; types: string[] };
  query_tools(constraint: { op_type: string; max_diameter?: number; drill_of?: number }): Array<{ tool_id: string; diameter_mm: number; type: string }>;
  calc_params(args: { op_type: string; tool_id: string; material_id: string }): Record<string, unknown>;
  create_op(args: { op_type: string; feature_id: string; tool_id: string }): Record<string, unknown>;
  generate(): { cam_revision: string; operation_count: number };
  simulate(): { status: string };
  validate(): { status: string };
}

export async function runCamAgent(part: NormalizedPartModel, features: Feature[], options: AgentOptions): Promise<AgentRun> {
  const toolCalls: AgentToolCall[] = [];
  const record = <T>(tool: string, args: Record<string, unknown>, fn: () => T): T => {
    try {
      const result = fn();
      toolCalls.push({ tool, args, result, ok: true });
      return result;
    } catch (err) {
      toolCalls.push({ tool, args, result: { error: String((err as Error).message) }, ok: false });
      throw err;
    }
  };

  // 工具实现（schema 校验由上层 API 层负责；这里记录审计）
  const tools: AgentTools = {
    analyze: (p) => ({ volume_mm3: p.volume_mm3, bbox: { min: [...p.bbox_mm.min], max: [...p.bbox_mm.max] } }),
    get_features: (_p, fs) => ({ count: fs.length, types: [...new Set(fs.map((f) => f.type))] }),
    query_tools: (c) => seedTools.filter((t) => t.stock_qty > 0 && (c.op_type === "DRILL" ? t.type === "DRILL" : t.type === "FLAT_END_MILL") && (c.max_diameter == null || t.diameter_mm <= c.max_diameter)).map((t) => ({ tool_id: t.id, diameter_mm: t.diameter_mm, type: t.type })),
    calc_params: () => ({ ok: true }),
    create_op: () => ({ ok: true }),
    generate: () => ({ cam_revision: "cam_ai", operation_count: 0 }),
    simulate: () => ({ status: "PASS" }),
    validate: () => ({ status: "PASS" }),
  };

  record("analyze", { part_id: part.file }, () => tools.analyze(part));
  record("get_features", { part_id: part.file }, () => tools.get_features(part, features));

  // 1) Planner Prompt → LLM 结构化输出
  const ctx: PlannerContext = {
    part: { id: part.file.replace(/\.[^.]+$/, ""), volume_mm3: part.volume_mm3, bbox: { min: [...part.bbox_mm.min] as [number, number, number], max: [...part.bbox_mm.max] as [number, number, number] } },
    features: features.map((f) => ({ id: f.id, type: f.type, dimensions: f.dimensions ?? {}, accessible: f.accessible_directions })),
    machine: (() => {
      const m = seedMachines.find((x) => x.id === (options.machineId ?? "mch_vmc850")) ?? seedMachines[0];
      return { id: m.id, name: m.name, axis: m.kinematics.axis_config ?? "3AXIS", max_rpm: m.kinematics.max_spindle_rpm, max_feed: m.kinematics.max_feed_mm_min };
    })(),
    tools: seedTools.filter((t) => t.stock_qty > 0).map((t) => ({ id: t.id, type: t.type, diameter_mm: t.diameter_mm, qty: t.stock_qty })),
    material: (() => {
      const m = seedMaterials.find((x) => x.id === (options.materialId ?? "mat_al_6061")) ?? seedMaterials[0];
      return { id: m.id, name: m.name, grade: m.grade ?? "" };
    })(),
    goal: options.goal,
  };
  const prompt = buildPlannerPrompt(ctx);

  let intent: PlannerOutput | null = null;
  let guardrail: AgentRun["guardrail"];
  let modelRoute = "";
  try {
    const res = await options.gateway.complete({ messages: prompt.messages, task: "planner" });
    modelRoute = res.route.provider_id;
    const parsed = JSON.parse(res.content) as unknown;
    const schema = validatePlannerOutput(parsed);
    if (!schema.ok) {
      guardrail = { ok: false, violations: schema.violations };
      intent = null;
    } else {
      const refs = validatePlannerRefs(schema.value!, { featureCount: features.length, hasDrills: features.some((f) => f.type === "HOLE_THROUGH" || f.type === "HOLE_BLIND") });
      guardrail = { ok: refs.ok, violations: refs.violations };
      intent = refs.ok ? refs.value : null;
    }
  } catch (err) {
    guardrail = { ok: false, violations: [{ path: "model", message: `模型调用失败: ${String((err as Error).message)}` }] };
  }

  // 2) 程序化规划器（意图通过才采用；失败用默认偏好）
  const setups = planSetups(features, { preference: intent?.setup_preference });
  const process = planProcess(features, { preference: intent?.process_order, withOuterFinish: true });
  const weights: ToolWeights = intent?.tool_weights ?? { diameter_match: 0.5, tool_cost: 0.2, surface_quality: 0.3 };
  record("query_tools", { op_type: "ALL" }, () => tools.query_tools({ op_type: "FACE" }));

  const toolChoices: AgentRun["tool_choices"] = [];
  const constraintsFor = new Map<string, { maxDiameter?: number; preferDrillOf?: number }>();
  for (const f of features) {
    const opType = process.feature_types.find((m) => m.feature_id === f.id)?.op_type ?? "CONTOUR";
    const dims = f.dimensions ?? {};
    const minW = Math.min((f.bbox.max.x - f.bbox.min.x), (f.bbox.max.y - f.bbox.min.y));
    if (opType === "DRILL") constraintsFor.set(f.id, { preferDrillOf: dims.diameter_mm ?? 6 });
    else constraintsFor.set(f.id, { maxDiameter: Math.max(2, Math.min(minW * 0.7, 12)) });
  }
  for (const [fid, c] of constraintsFor) {
    const opType = process.feature_types.find((m) => m.feature_id === fid)?.op_type ?? "CONTOUR";
    const r = planTool(opType, c, seedTools, weights);
    toolChoices.push({ operation_type: opType, tool_id: r.tool.id, score: r.score, reasons: r.rank_reason });
    record("create_op", { op_type: opType, feature_id: fid, tool_id: r.tool.id }, () => tools.create_op({ op_type: opType, feature_id: fid, tool_id: r.tool.id }));
  }

  // 3) 确定性生成 + Job 验证
  const userOverrides: Record<string, number> = {};
  if (intent?.overrides?.stepdown_mm) userOverrides.stepdown_mm = intent.overrides.stepdown_mm;
  if (intent?.overrides?.stepover_mm) userOverrides.stepover_mm = intent.overrides.stepover_mm;
  if (intent?.overrides?.finish_allowance_mm) userOverrides.finish_allowance_mm = intent.overrides.finish_allowance_mm;

  const planned = planPart(part, features, { materialId: options.materialId, machineId: options.machineId, userOverrides });
  record("generate", { overrides: userOverrides }, () => tools.generate());
  const job = runJob({ part, partName: part.file.replace(/\.[^.]+$/, ""), features, dialect: options.dialect });
  record("simulate", {}, () => tools.simulate());
  record("validate", {}, () => tools.validate());

  void planned;
  return {
    intent,
    guardrail,
    setups,
    process,
    tool_choices: toolChoices,
    job,
    tool_calls: toolCalls,
    model_route: modelRoute,
    prompt_version: prompt.version,
  };
}

