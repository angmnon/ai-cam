import io

p = r"C:\Users\86189\Documents\CNC-Gcode\ai-cam\apps\web\src\api.ts"
s = io.open(p, encoding="utf-8").read()
old = "export { BASE };"
new = """// ---- Phase 4 AI 规划 / Release（P4-9 / P4-11） ----
export interface AiPlanResult {
  plan: { id: string; created_at: string };
  intent: { strategy: string; setup_preference?: string; process_order?: string; tool_weights?: Record<string, number>; overrides?: Record<string, number> } | null;
  guardrail: { ok: boolean; violations: Array<{ path: string; message: string }> };
  setups: Array<{ id: string; name: string; wcs: string; coverage: number; reasons: string[] }>;
  process: { order: Array<{ op_type: string; feature_id: string }>; feature_types: Array<{ feature_id: string; op_type: string }>; validation: { ok: boolean; violations: string[] } };
  tool_choices: Array<{ operation_type: string; tool_id: string; score: number; reasons: string[] }>;
  change_set: {
    before: { cam_revision_id: string; operation_count: number; tools: string[]; setups: string[] } | null;
    after: { operation_count: number; tools: string[]; setups: string[] };
    reasons: string[];
  };
  job: { validated: boolean; simulation_status: string; validation_status: string };
}

export interface ReleaseRecord {
  id: string;
  part_id: string;
  cam_revision_id: string;
  job_run_id: string;
  version_no: number;
  status: "PENDING_APPROVAL" | "APPROVED" | "RELEASED" | "REJECTED";
  requested_by: string;
  approved_by?: string;
  approval_note?: string;
  qr_token: string;
  created_at: string;
  approved_at?: string;
  released_at?: string;
}

export { BASE };"""
assert old in s
s = s.replace(old, new)
old2 = "  getJobValidation: (id: string) => request<{ data: ValidationReport }>(\"GET\", `/api/v1/parts/${id}/job/validation`),\n};"
new2 = """  getJobValidation: (id: string) => request<{ data: ValidationReport }>("GET", `/api/v1/parts/${id}/job/validation`),

  // Phase 4
  runAiPlan: (id: string, goal: string) => request<{ data: AiPlanResult }>("POST", `/api/v1/parts/${id}/ai-plan`, { goal }),
  listAiPlans: (id: string) => request<{ data: Array<{ id: string; goal: string; intent: unknown; guardrail: { ok: boolean; violations: unknown[] }; model_route: string; prompt_version: string; change_set: unknown; tool_calls: Array<{ tool: string; ok: boolean }>; created_at: string }> }>("GET", `/api/v1/parts/${id}/ai-plans`),
  applyAiPlan: (id: string, planId: string) => request<{ data: { revision_id: string; revision_no: number; job_run_id: string } }>("POST", `/api/v1/parts/${id}/ai-plans/${planId}/apply`),
  createRelease: (id: string) => request<{ data: ReleaseRecord }>("POST", `/api/v1/parts/${id}/release`),
  listReleases: (id: string) => request<{ data: ReleaseRecord[] }>("GET", `/api/v1/parts/${id}/releases`),
  approveRelease: (id: string, releaseId: string, note?: string) => request<{ data: ReleaseRecord }>("POST", `/api/v1/parts/${id}/releases/${releaseId}/approve`, { note }),
  releaseNow: (id: string, releaseId: string) => request<{ data: ReleaseRecord }>("POST", `/api/v1/parts/${id}/releases/${releaseId}/release`, {}),
};"""
assert old2 in s, "api tail anchor"
s = s.replace(old2, new2)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("WEB-API-EXTENDED")
