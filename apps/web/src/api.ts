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
  setups: Array<{ id: string; name: string; wcs: string; origin: { x: number; y: number; z: number } }>;
  tools: Array<{ tool_id: string; tool_number: number }>;
  operations: CamOperation[];
  toolpaths: CamToolpath[];
  metadata: { generated_by: string; generator_version: string; created_at: string };
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

let token: string | null = localStorage.getItem("ai_cam_token");

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem("ai_cam_token", t);
  else localStorage.removeItem("ai_cam_token");
}

export function hasToken(): boolean {
  return !!token;
}

async function request<T>(method: string, path: string, body?: unknown, raw?: boolean, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
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
};

export { BASE };
