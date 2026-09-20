/**
 * CAM IR Validator：Schema 校验 + 跨对象引用校验 + 硬性参数边界校验。
 * 返回结构化错误列表；AI 输出必须通过本校验才能进入 CAM Kernel。
 */
import { CamIR, CamIR as CamIRType, camIrHash, canonicalJson } from "./schema.js";

export type Severity = "ERROR" | "WARNING";

export interface ValidationIssue {
  severity: Severity;
  code: string;
  path: string;
  message: string;
}

export interface CamIRValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  hash?: string;
}

function refIssue(severity: Severity, code: string, path: string, message: string): ValidationIssue {
  return { severity, code, path, message };
}

export function validateCamIR(input: unknown): CamIRValidationResult {
  const issues: ValidationIssue[] = [];

  const parsed = CamIR.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(
        refIssue(
          "ERROR",
          "SCHEMA",
          issue.path.join("."),
          `${issue.message} (expected ${JSON.stringify(issue.code)})`,
        ),
      );
    }
    return { ok: false, issues };
  }

  const ir: CamIRType = parsed.data;
  const setupIds = new Set(ir.setups.map((s) => s.id));
  const toolIds = new Set(ir.tools.map((t) => t.tool_id));

  // 引用校验：operation.setup_id / tool_id
  for (const op of ir.operations) {
    if (!setupIds.has(op.setup_id)) {
      issues.push(refIssue("ERROR", "REF_SETUP", `operations.${op.id}.setup_id`, `setup_id "${op.setup_id}" not found`));
    }
    if (!toolIds.has(op.tool.tool_id)) {
      issues.push(refIssue("ERROR", "REF_TOOL", `operations.${op.id}.tool.tool_id`, `tool_id "${op.tool.tool_id}" not found`));
    }
    // depends_on 自引用 / 未知引用
    for (const dep of op.depends_on) {
      if (dep === op.id) {
        issues.push(refIssue("ERROR", "REF_SELF", `operations.${op.id}.depends_on`, "operation cannot depend on itself"));
      }
      if (!ir.operations.some((o) => o.id === dep)) {
        issues.push(refIssue("ERROR", "REF_DEP", `operations.${op.id}.depends_on`, `dependency "${dep}" not found`));
      }
    }
  }

  // 硬边界：主轴转速不超过机床上限
  for (const op of ir.operations) {
    const maxRpm = ir.machine.max_spindle_rpm;
    if (maxRpm !== undefined && op.parameters.spindle_speed_rpm > maxRpm) {
      issues.push(
        refIssue(
          "ERROR",
          "PARAM_SPINDLE",
          `operations.${op.id}.parameters.spindle_speed_rpm`,
          `spindle ${op.parameters.spindle_speed_rpm} exceeds machine max ${maxRpm}`,
        ),
      );
    }
  }

  // 警告：工序顺序索引必须唯一
  const seenIndex = new Map<number, string>();
  for (const op of ir.operations) {
    const prev = seenIndex.get(op.op_index);
    if (prev !== undefined) {
      issues.push(refIssue("WARNING", "DUP_OP_INDEX", `operations.${op.id}.op_index`, `op_index ${op.op_index} duplicated with ${prev}`));
    } else {
      seenIndex.set(op.op_index, op.id);
    }
  }

  return { ok: issues.every((i) => i.severity !== "ERROR"), issues, hash: camIrHash(ir) };
}

export { canonicalJson };
