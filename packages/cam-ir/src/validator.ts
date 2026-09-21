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
  const operationIds = new Set(ir.operations.map((o) => o.id));

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

  // P2-03 硬边界：进给率不超过机床 max_feed（feed>0 由 schema .positive() 保证）
  for (const op of ir.operations) {
    const maxFeed = ir.machine.max_feed;
    if (maxFeed !== undefined && op.parameters.feed_mm_min > maxFeed) {
      issues.push(
        refIssue(
          "ERROR",
          "PARAM_FEED",
          `operations.${op.id}.parameters.feed_mm_min`,
          `feed_mm_min ${op.parameters.feed_mm_min} exceeds machine max_feed ${maxFeed}`,
        ),
      );
    }
  }

  // P2-03 硬边界：safe_z_mm 必须高于毛坯顶面（BOX 毛坯 z 维度）
  const stockTopZ = ir.stock.dimensions?.z;
  if (stockTopZ !== undefined) {
    for (const op of ir.operations) {
      if (op.safe_z_mm === undefined) continue;
      if (op.safe_z_mm < 0) {
        issues.push(
          refIssue(
            "ERROR",
            "PARAM_SAFE_Z",
            `operations.${op.id}.safe_z_mm`,
            `safe_z_mm ${op.safe_z_mm} must be >= 0`,
          ),
        );
      } else if (op.safe_z_mm <= stockTopZ) {
        issues.push(
          refIssue(
            "ERROR",
            "PARAM_SAFE_Z",
            `operations.${op.id}.safe_z_mm`,
            `safe_z_mm ${op.safe_z_mm} must be above stock top z=${stockTopZ}`,
          ),
        );
      }
    }
  }

  // P2-04 引用校验：toolpaths[].operation_id 必须存在
  if (Array.isArray(ir.toolpaths)) {
    for (const tp of ir.toolpaths) {
      if (!operationIds.has(tp.operation_id)) {
        issues.push(
          refIssue(
            "ERROR",
            "REF_OP",
            `toolpaths.${tp.toolpath_id}.operation_id`,
            `operation_id "${tp.operation_id}" not found in operations`,
          ),
        );
      }
      // P2-04 交叉校验：move_count 必须与实际 moves.length 一致
      if (tp.move_count !== tp.moves.length) {
        issues.push(
          refIssue(
            "ERROR",
            "COUNT_MISMATCH",
            `toolpaths.${tp.toolpath_id}.move_count`,
            `move_count ${tp.move_count} != moves.length ${tp.moves.length}`,
          ),
        );
      }
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
