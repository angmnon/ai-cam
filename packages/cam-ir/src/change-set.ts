/**
 * ChangeSet：AI 对 CAM IR 的增量修改（可审查、可回滚、可审批）。
 * 所有 AI 修改必须携带 reason + source + requires_validation（04/07 文档）。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ChangeKind = z.enum([
  "ADD_OPERATION",
  "UPDATE_OPERATION",
  "REMOVE_OPERATION",
  "ADD_SETUP",
  "UPDATE_SETUP",
  "CHANGE_TOOL",
  "UPDATE_PARAMETERS",
  "REORDER_OPERATIONS",
  "UPDATE_STOCK",
]);
export type ChangeKind = z.infer<typeof ChangeKind>;

export const Change = z.object({
  id: z.string(),
  kind: ChangeKind,
  /** 变更目标（operation_id / setup_id / tool_id / 全局） */
  target: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  reason: z.string().min(1),
});
export type Change = z.infer<typeof Change>;

export const ChangeSet = z.object({
  id: z.string(),
  job_id: z.string(),
  source: z.string(), // "ai-master-agent" / "ai-assistant" / "user"
  confidence: z.number().min(0).max(1).optional(),
  changes: z.array(Change).min(1),
  requires_validation: z.boolean().default(true),
  created_at: z.string(),
  created_by: z.string().optional(),
});
export type ChangeSet = z.infer<typeof ChangeSet>;

export function makeChangeSet(
  jobId: string,
  source: string,
  changes: Array<Omit<Change, "id">>,
  opts: { confidence?: number; requiresValidation?: boolean } = {},
): ChangeSet {
  return {
    id: `cs_${randomUUID()}`,
    job_id: jobId,
    source,
    confidence: opts.confidence,
    changes: changes.map((c) => ({ ...c, id: `chg_${randomUUID()}` })),
    requires_validation: opts.requiresValidation ?? true,
    created_at: new Date().toISOString(),
  };
}
