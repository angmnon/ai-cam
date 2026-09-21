/** API 客户端（Phase 1：登录 / 零件流水线 / 主数据） */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080";

export interface ApiUser {
  sub: string;
  org_id: string;
  roles: string[];
}

export interface LoginResult {
  token: string;
  user: ApiUser;
}

export interface PartSummary {
  id: string;
  filename: string;
  status: "PENDING" | "PARSING" | "ANALYZED" | "FAILED";
  source_key: string;
  created_at: string;
  failure?: { code: string; message: string; stage?: string };
  analysis?: {
    part: {
      occt_version: string;
      healing_valid: boolean;
      solid_count: number;
      bbox_mm: { min: [number, number, number]; max: [number, number, number] };
      volume_mm3: number;
      face_count: number;
    };
    features: FeatureGraph;
    dfm: DfmReport;
    mesh_key?: string;
  };
}

export interface FeatureGraph {
  part_id: string;
  features: Feature[];
  edges: unknown[];
  recognizer_version: string;
  created_at: string;
}

export interface Feature {
  id: string;
  type: string;
  confidence: number;
  source_face_ids: string[];
  bbox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  accessible_directions: string[];
  dimensions?: Record<string, number>;
  recognizer_version: string;
  recognized_by: string;
}

export interface DfmReport {
  part_id: string;
  rules_version: string;
  created_at: string;
  summary: { info: number; warning: number; blocker: number };
  items: Array<{
    id: string;
    severity: "INFO" | "WARNING" | "BLOCKER";
    code: string;
    message: string;
    feature_ids: string[];
    details?: Record<string, number>;
  }>;
}

// ---- Phase 2 CAM IR（最小子集） ----
export interface CamMove {
  type: "RAPID" | "LINEAR" | "ARC_CW" | "ARC_CCW" | "PLUNGE" | "RETRACT";
  x: number;
  y: number;
  z: number;
  feed_mm_min?: number;
}

export interface CamOperation {
  id: string;
  op_index: number;
  name: string;
  type: string;
  feature_ids: string[];
  tool: { tool_id: string; tool_number: number; rank: number; rank_reason: string[] };
  parameters: Record<string, unknown>;
  depends_on: string[];
  safe_z_mm: number;
}

export interface CamToolpath {
  operation_id: string;
  toolpath_id: string;
  move_count: number;
  engine_version: string;
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  moves: CamMove[];
}

export interface CamIr {
  schema_version: string;
  ir_id: string;
  job_id: string;
  part_id: string;
  machine: { machine_name: string; axis_config: string; max_spindle_rpm: number; max_feed: number };
  material: { material_name: string; grade: string };
  stock: { kind: string; dimensions: { x: number; y: number; z: number }; margin: { x: number; y: number; z: number } };
  setups: Array<{ id: string; name: string; wcs: string; origin: { x: number; y: number; z: number }; rotation?: { axis: "A" | "B"; angle: number }; part_faces?: string[] }>;
  tools: Array<{ tool_id: string; tool_number: number }>;
  operations: CamOperation[];
  toolpaths: CamToolpath[];
  metadata: { generated_by: string; generator_version: string; created_at: string };
}

// ---- Phase 3 Job / 仿真（P3-4/P3-8/P3-9） ----
export interface SimFrame {
  operation_id: string;
  step: number;
  snapshot: Array<{ x: number; y: number; z: number; solid: boolean }>;
}

export interface JobSummary {
  job: { id: string; status: "PASS" | "WARN" | "FAIL"; validated: boolean; pipeline: Array<{ stage: string; status: "PASS" | "WARN" | "FAIL"; detail: string }> };
  nc: { program_number: string; dialect: string; line_count: number; move_count: number; tool_changes: number };
  simulation: { status: "PASS" | "WARN" | "FAIL"; removed_volume_mm3: number; residual_volume_mm3: number; events: number; frames?: SimFrame[] };
  validation: { id: string; status: "PASS" | "WARN" | "FAIL"; layers: Array<{ layer: string; status: string; checks: number }> };
}

export interface ValidationReport {
  schema_version: string;
  report_id: string;
  nc_program: string;
  ir_id: string;
  job_id: string;
  part_id: string;
  validator_version: string;
  status: "PASS" | "WARN" | "FAIL";
  layers: Array<{ layer: string; status: string; checks: Array<{ code: string; severity: string; message: string; layer: string; line?: number }> }>;
}

class ApiErrorClient extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// ---- P2-02: 会话迁移到 HttpOnly cookie ----
//
// 【变更】原 P2-44 将 JWT 存于 localStorage（key: ai_cam_token），可被任意同源 JS 读取，
// 一旦存在 XSS 即可被盗用。P2-02 起，登录由后端下发 HttpOnly Cookie `aicam_session`，
// 浏览器自动携带，前端 JS 不再持有 token 明文，从根上消除 XSS 对会话的窃取面。
//
// 【前端约定】
//   - 所有 fetch 必须带 credentials: "include"，cookie 才会跨源（5173→8080/8090）携带；
//   - 不再读 localStorage / document.cookie，也不再 Authorization: Bearer；
//   - hasToken() 仅作占位（HttpOnly cookie JS 不可读）：登录成功后由调用方 onLoggedIn() 切视图；
//   - 登出调用 POST /auth/logout 让后端清 cookie。
//
// 注意：后端 CORS 必须 credentials:true 且 origin 精确白名单（不 wildcard），否则浏览器拒绝携带 cookie。

/** 占位：HttpOnly cookie 不可由 JS 读取，故无法在前端探测会话是否存在。
 *  初始视图一律走登录页；登录成功后由 LoginView onLoggedIn() 推进。
 *  保留导出以兼容 App.tsx 现有调用签名。 */
export function hasToken(): boolean {
  return false;
}

/** P2-02：登出（后端清 cookie）。 */
export async function logout(): Promise<void> {
  try {
    await fetch(`${BASE}/api/v1/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    /* 网络错误也强制回到登录页；本地无需清理任何状态 */
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: boolean, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined && !raw) headers["content-type"] = "application/json";
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    // P2-02：cookie 跨源携带（HttpOnly aicam_session 由浏览器自动附加）
    credentials: "include",
    body: raw ? (body as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: { error?: { code?: string; message?: string } } = {};
    try {
      err = (await res.json()) as typeof err;
    } catch {
      /* noop */
    }
    throw new ApiErrorClient(err.error?.code ?? "HTTP_ERROR", err.error?.message ?? `${method} ${path} -> ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string, organization_id = "org_demo") =>
    request<{ data: LoginResult }>("POST", "/api/v1/auth/login", { email, password, organization_id }),

  createPart: (payload: { filename: string; content_type: string; size_bytes: number }) =>
    request<{ data: { part: PartSummary; upload_session: { file_id: string; upload_url: string; method: string; headers: Record<string, string> } } }>("POST", "/api/v1/parts", payload),

  uploadBytes: (uploadUrl: string, headers: Record<string, string>, body: ArrayBuffer) =>
    request<{ data: unknown }>("POST", uploadUrl, body, true, headers),

  analyzePart: (id: string) => request<{ data: PartSummary }>("POST", `/api/v1/parts/${id}/analyze`),

  getPart: (id: string) => request<{ data: PartSummary }>("GET", `/api/v1/parts/${id}`),

  getFeatures: (id: string) => request<{ data: FeatureGraph }>("GET", `/api/v1/parts/${id}/features`),

  getDfm: (id: string) => request<{ data: DfmReport }>("GET", `/api/v1/parts/${id}/dfm`),

  meshUrl: (id: string) => `${BASE}/api/v1/parts/${id}/mesh`,

  listParts: () => request<{ data: PartSummary[] }>("GET", "/api/v1/parts"),
  generateToolpath: (id: string) =>
    request<{ data: { revision: { id: string; revision_no: number; engine_version: string }; cam: CamIr; parameter_decisions: Record<string, unknown> } }>("POST", `/api/v1/parts/${id}/toolpath`),

  getToolpath: (id: string) =>
    request<{ data: { revision_id: string; revision_no: number; engine_version: string; cam: CamIr } }>("GET", `/api/v1/parts/${id}/toolpath`),

  runJob: (id: string) => request<{ data: JobSummary }>("POST", `/api/v1/parts/${id}/job`),

  getJob: (id: string) => request<{ data: unknown }>("GET", `/api/v1/parts/${id}/job`),

  getJobNc: (id: string) => request<{ data: unknown }>("GET", `/api/v1/parts/${id}/job/nc`),

  getJobValidation: (id: string) => request<{ data: ValidationReport }>("GET", `/api/v1/parts/${id}/job/validation`),

  // Phase 4
  runAiPlan: (id: string, goal: string) => request<{ data: AiPlanResult }>("POST", `/api/v1/parts/${id}/ai-plan`, { goal }),
  listAiPlans: (id: string) =>
    request<{ data: Array<{ id: string; goal: string; intent: unknown; guardrail: { ok: boolean; violations: unknown[] }; model_route: string; prompt_version: string; change_set: unknown; tool_calls: Array<{ tool: string; ok: boolean }>; created_at: string }> }>("GET", `/api/v1/parts/${id}/ai-plans`),
  applyAiPlan: (id: string, planId: string) => request<{ data: { revision_id: string; revision_no: number; job_run_id: string } }>("POST", `/api/v1/parts/${id}/ai-plans/${planId}/apply`),
  createRelease: (id: string) => request<{ data: ReleaseRecord }>("POST", `/api/v1/parts/${id}/release`),
  listReleases: (id: string) => request<{ data: ReleaseRecord[] }>("GET", `/api/v1/parts/${id}/releases`),
  approveRelease: (id: string, releaseId: string, note?: string) => request<{ data: ReleaseRecord }>("POST", `/api/v1/parts/${id}/releases/${releaseId}/approve`, { note }),
  releaseNow: (id: string, releaseId: string) => request<{ data: ReleaseRecord }>("POST", `/api/v1/parts/${id}/releases/${releaseId}/release`, {}),

  // ---- P2-49：以下为按 services/api 真实路由补齐的调用（不伪造后端不存在的端点）----
  // P3-9：Job 报告（工艺单/刀具清单/Setup Sheet/仿真摘要）
  getJobReport: (id: string) => request<{ data: JobReport }>("GET", `/api/v1/parts/${id}/job/report`),

  // P4-11：Release 详情 / 驳回（驳回 note 必填，与后端 ReleaseRejectBody 对齐）
  getRelease: (id: string, releaseId: string) => request<{ data: ReleaseRecord }>("GET", `/api/v1/parts/${id}/releases/${releaseId}`),
  rejectRelease: (id: string, releaseId: string, note: string, profile?: string) =>
    request<{ data: ReleaseRecord }>("POST", `/api/v1/parts/${id}/releases/${releaseId}/reject`, { note, profile }),

  // 独立 Jobs 工作流（/api/v1/jobs），区别于零件级一键 runJob（POST /parts/:id/job）
  createJob: (input: JobInput, idempotencyKey?: string) =>
    request<{ data: JobRecord }>("POST", "/api/v1/jobs", { input }, false, idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined),
  listJobs: (opts?: { offset?: number; limit?: number; status?: JobStatus }) =>
    request<{ data: JobRecord[]; meta: PageMeta }>(
      "GET",
      `/api/v1/jobs?offset=${opts?.offset ?? 0}&limit=${opts?.limit ?? 20}${opts?.status ? `&status=${encodeURIComponent(opts.status)}` : ""}`,
    ),
  getJobById: (id: string) => request<{ data: JobRecord }>("GET", `/api/v1/jobs/${id}`),
  transitionJob: (id: string, to: JobStatus, reason?: string) =>
    request<{ data: JobRecord }>("POST", `/api/v1/jobs/${id}/transition`, { to, reason }),
  failJob: (id: string, body: { code: string; message: string; stage?: string; retryable?: boolean }) =>
    request<{ data: JobRecord }>("POST", `/api/v1/jobs/${id}/fail`, body),

  // 主数据（机床/控制器/刀具/材料/切削规则）；精确字段由后端 domain-schemas 决定，前端以结构化记录透传
  getMasterMachines: () => request<{ data: Array<Record<string, unknown>> }>("GET", "/api/v1/master/machines"),
  getMasterControllers: () => request<{ data: Array<Record<string, unknown>> }>("GET", "/api/v1/master/controllers"),
  getMasterTools: () => request<{ data: Array<Record<string, unknown>> }>("GET", "/api/v1/master/tools"),
  getMasterMaterials: () => request<{ data: Array<Record<string, unknown>> }>("GET", "/api/v1/master/materials"),
  getMasterCuttingRules: () => request<{ data: Array<Record<string, unknown>> }>("GET", "/api/v1/master/cutting-rules"),
};

/**
 * P1-22：拉取网格二进制。
 * P2-02：不再带 Authorization 头；靠 credentials:include 让浏览器自动附 HttpOnly cookie。
 * 返回 Blob，调用方按需 URL.createObjectURL / text()。
 */
export async function fetchMeshBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new ApiErrorClient(res.headers.get("x-error-code") ?? "HTTP_ERROR", `网格加载失败：HTTP ${res.status}${res.status === 401 ? "（未授权，请重新登录）" : ""}`, res.status);
  }
  return res.blob();
}

// ---- Phase 4 AI 规划 / Release（P4-9 / P4-11） ----
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

export { BASE };

// ---- P2-49：独立 Jobs 工作流（/api/v1/jobs）类型，对齐 @ai-cam/job-schema ----
export type JobStatus =
  | "DRAFT"
  | "UPLOADING"
  | "PARSING"
  | "ANALYZING"
  | "PLANNING"
  | "GENERATING_TOOLPATH"
  | "SIMULATING"
  | "VALIDATING"
  | "READY_FOR_REVIEW"
  | "APPROVED"
  | "RELEASED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED"
  | "NEEDS_USER_INPUT"
  | "NEEDS_ENGINEER_REVIEW";

export interface JobInput {
  part_id: string;
  machine_id: string;
  controller_id: string;
  material_id: string;
  stock_policy?: "AUTO" | "MANUAL";
  axis_mode?: "3AXIS" | "INDEXED_4AXIS";
  fixture_mode?: "AUTO" | "MANUAL" | "NONE";
}

export interface JobRecord {
  id: string;
  organization_id: string;
  machine_id: string;
  controller_id: string;
  material_id: string;
  status: JobStatus;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  failure?: { code: string; message: string; stage?: string; retryable: boolean; occurred_at: string };
}

export interface PageMeta {
  offset: number;
  limit: number;
  total: number;
}

// ---- P2-49：P3-9 Job 报告结构（对齐 services/api buildJobReport 返回）----
export interface JobReport {
  schema_version: string;
  part_id: string;
  job_id: string;
  ir_id: string;
  program_number: string;
  status: "PASS" | "WARN" | "FAIL";
  validated: boolean;
  engine_version: string;
  generated_at: string;
  summary: {
    part_id: string;
    machine: string;
    machine_id: string;
    controller: string;
    controller_id: string;
    axis_config: string;
    material: string;
    material_id: string;
    stock: { kind: string; dimensions: Record<string, number> };
    operation_count: number;
    tool_count: number;
  };
  setup_sheet: Array<{ setup_id: string; name?: string; wcs: string; origin: { x: number; y: number; z: number } }>;
  tool_list: Array<{ tool_id: string; tool_number: number; name: string; type: string; diameter_mm: number; operations: string[] }>;
  process_sheet: Array<{
    op_index: number;
    operation_id: string;
    type: string;
    name?: string;
    tool_id: string;
    tool_number: number;
    spindle_rpm: number;
    feed_mm_min: number;
    stepdown_mm?: number;
    coolant: string;
    move_count: number;
    feature_ids: string[];
  }>;
  simulation: {
    status: "PASS" | "WARN" | "FAIL";
    voxel_size_mm: number;
    initial_volume_mm3: number;
    removed_volume_mm3: number;
    residual_volume_mm3: number;
    removal_error_pct: number;
    events: Array<{ kind: string; severity: string; message: string }>;
  };
  validation: { status: "PASS" | "WARN" | "FAIL"; layers: Array<{ layer: string; status: string; checks: number }> };
}

// ---- P2-49：SSE 事件订阅（GET /api/v1/events/stream?subject=job_xxx）----
// 后端鉴权要求 Authorization: Bearer，而原生 EventSource 无法携带自定义请求头，
// 故用 fetch + 流式读取解析 SSE 帧；subject 必须以 "job_" 开头（后端校验）。

export function eventsStreamUrl(subject?: string): string {
  const u = new URL(`${BASE}/api/v1/events/stream`);
  if (subject) u.searchParams.set("subject", subject);
  return u.toString();
}

export interface CloudEventLike {
  type: string;
  subject?: string;
  specversion?: string;
  id?: string;
  source?: string;
  time?: string;
  data?: unknown;
  [k: string]: unknown;
}

/** 订阅 SSE 事件流，onEvent 收到解析后的 CloudEvent JSON；返回取消订阅函数。 */
export function subscribeEvents(subject: string | undefined, onEvent: (evt: CloudEventLike) => void): () => void {
  const ctrl = new AbortController();
  void (async () => {
    try {
      // P2-02：credentials:include 自动带 HttpOnly cookie（EventSource 不能带自定义头，故仍走 fetch 流式）
      const res = await fetch(eventsStreamUrl(subject), { credentials: "include", signal: ctrl.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // SSE 事件以空行分隔
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = rawEvent
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""));
          if (dataLines.length === 0) continue;
          try {
            onEvent(JSON.parse(dataLines.join("\n")) as CloudEventLike);
          } catch {
            /* 非 JSON 帧忽略 */
          }
        }
      }
    } catch {
      /* 主动取消或网络中断 */
    }
  })();
  return () => ctrl.abort();
}
