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

// ---- P2-44: Auth token 读取与风险标注 ----
//
// 【风险】当前 token 存放于 localStorage（key: ai_cam_token）。localStorage 可被任意同源
// JavaScript 读取，一旦前端存在 XSS 漏洞，攻击者即可读取并盗用 token，进而冒用用户身份
// 调用后端 API。
//
// 【后续迁移方向】将 token 改为后端下发的 HttpOnly + Secure + SameSite Cookie，前端不再
// 持有 token 明文，由浏览器自动携带，从根本上消除 XSS 对 token 的窃取面。在迁移完成前，
// 本文件兼容三种 token 来源以支持嵌入式 / 网关注入场景：
//   1) 显式注入 token（setAuthToken 或首次 ?token= URL 注入）——优先级最高
//   2) localStorage ai_cam_token（现有登录写入路径，保持不变）
//   3) Cookie ai_cam_token（document.cookie 解析）

const TOKEN_STORAGE_KEY = "ai_cam_token";

// 显式注入的 token：来自 setAuthToken() 或模块加载时对 URL ?token= 的一次性捕获。
let injectedToken: string | null = null;

// 兼容旧路径：登录后写入 localStorage 的 token 仍由 setToken() 维护（登录流程不改）。
let token: string | null = localStorage.getItem(TOKEN_STORAGE_KEY);

function readCookieToken(): string | null {
  if (typeof document === "undefined") return null;
  const raw: string = document.cookie || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === TOKEN_STORAGE_KEY) {
      const val = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    }
  }
  return null;
}

// 首次 URL 注入：?token=xxx 在模块加载时捕获，并立即从地址栏抹除，
// 避免 token 泄漏到浏览器历史 / Referer / 服务端访问日志。
function captureUrlToken(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  try {
    const u = new URL(window.location.href);
    const t = u.searchParams.get("token");
    if (t) {
      u.searchParams.delete("token");
      window.history.replaceState(null, "", u.toString());
      return t;
    }
  } catch {
    /* noop */
  }
  return null;
}

/** P2-44：显式注入 token（嵌入式 / 网关 / 临时调试用）。传 null 清除。 */
export function setAuthToken(t: string | null): void {
  injectedToken = t;
}

/** P2-44：按 显式注入 > localStorage > Cookie 优先级解析当前 token。 */
export function getAuthToken(): string | null {
  if (injectedToken) return injectedToken;
  const ls = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (ls) return ls;
  return readCookieToken();
}

// 模块加载时执行一次 URL ?token= 注入捕获。
injectedToken = captureUrlToken();

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem(TOKEN_STORAGE_KEY, t);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function hasToken(): boolean {
  return !!getAuthToken();
}

/** P2-44：统一构造 Authorization 头（fetchMeshBlob 除外，按既有路径保留）。 */
function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const t = getAuthToken();
  if (t) headers.authorization = `Bearer ${t}`;
  return headers;
}

async function request<T>(method: string, path: string, body?: unknown, raw?: boolean, extraHeaders?: Record<string, string>): Promise<T> {
  const headers = buildAuthHeaders();
  if (body !== undefined && !raw) headers["content-type"] = "application/json";
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
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
};

/**
 * P1-22：以带 Authorization 头的方式拉取网格二进制（裸 fetch 不带 token 会 401）。
 * 返回 Blob，调用方按需 URL.createObjectURL / text()。
 */
export async function fetchMeshBlob(url: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
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
