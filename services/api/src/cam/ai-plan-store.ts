/**
 * AI 规划审计存储（P4-9）：每次 AI 规划（Preview）落一条记录，Apply 时回放 change_set。
 */
import { randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";

export interface AiPlanChangeSet {
  before: { cam_revision_id: string; operation_count: number; tools: string[]; setups: string[] } | null;
  after: { operation_count: number; tools: string[]; setups: string[] };
  reasons: string[];
}

export interface AiPlanRecord {
  id: string;
  organization_id: string;
  part_id: string;
  goal: string;
  intent: Record<string, unknown>;
  guardrail: { ok: boolean; violations: Array<{ path: string; message: string }> };
  model_route: string;
  prompt_version: string;
  change_set: AiPlanChangeSet;
  tool_calls: Array<{ tool: string; ok: boolean }>;
  created_by: string;
  created_at: string;
}

export interface AiPlanStore {
  create(input: Omit<AiPlanRecord, "id" | "created_at">): AiPlanRecord;
  list(orgId: string, partId: string): AiPlanRecord[];
  get(orgId: string, partId: string, planId: string): AiPlanRecord;
}

export function createAiPlanStore(): AiPlanStore {
  const byId = new Map<string, AiPlanRecord>();
  return {
    create(input) {
      const rec: AiPlanRecord = { ...input, id: `aiplan_${randomUUID().replaceAll("-", "")}`, created_at: new Date().toISOString() };
      byId.set(rec.id, rec);
      return rec;
    },
    list(orgId, partId) {
      return [...byId.values()].filter((r) => r.part_id === partId && r.organization_id === orgId).sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    get(orgId, partId, planId) {
      const r = byId.get(planId);
      if (!r || r.part_id !== partId || r.organization_id !== orgId) throw new ApiError({ code: ErrorCodes.CAM_REVISION_NOT_FOUND, message: "AI plan not found.", stage: "ai-plans", retryable: false });
      return r;
    },
  };
}
