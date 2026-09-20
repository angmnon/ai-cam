/**
 * 统一错误码。
 * 前缀规则见《03_API接口规范》：AUTH_* 身份权限 / FILE_* 文件 / CAD_* 几何 /
 * CAM_* CAM / SIM_* 仿真 / NC_* NC / MASTER_* 主数据 / JOB_* 任务 / AI_* AI / SYSTEM_* 系统。
 */

export const ErrorCodes = {
  // ---- AUTH ----
  AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",
  AUTH_TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  AUTH_TENANT_MISMATCH: "AUTH_TENANT_MISMATCH",
  AUTH_MFA_REQUIRED: "AUTH_MFA_REQUIRED",

  // ---- FILE ----
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  FILE_INVALID_TYPE: "FILE_INVALID_TYPE",
  FILE_VIRUS_DETECTED: "FILE_VIRUS_DETECTED",
  FILE_UPLOAD_FAILED: "FILE_UPLOAD_FAILED",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  FILE_SIGNATURE_INVALID: "FILE_SIGNATURE_INVALID",

  // ---- CAD / 几何 ----
  CAD_PARSE_FAILED: "CAD_PARSE_FAILED",
  CAD_INVALID_SOLID: "CAD_INVALID_SOLID",
  CAD_UNSUPPORTED_FORMAT: "CAD_UNSUPPORTED_FORMAT",
  CAD_HEALING_FAILED: "CAD_HEALING_FAILED",
  CAD_GEOMETRY_ERROR: "CAD_GEOMETRY_ERROR",

  // ---- CAM ----
  CAM_TOOL_REACH_FAILED: "CAM_TOOL_REACH_FAILED",
  CAM_NO_VALID_SETUP: "CAM_NO_VALID_SETUP",
  CAM_TOOLPATH_GENERATION_FAILED: "CAM_TOOLPATH_GENERATION_FAILED",
  CAM_PARAMETER_OUT_OF_RANGE: "CAM_PARAMETER_OUT_OF_RANGE",
  CAM_IR_INVALID: "CAM_IR_INVALID",
  CAM_FEATURE_NOT_FOUND: "CAM_FEATURE_NOT_FOUND",
  CAM_REVISION_NOT_FOUND: "CAM_REVISION_NOT_FOUND",

  // ---- SIM ----
  SIM_COLLISION_DETECTED: "SIM_COLLISION_DETECTED",
  SIM_GOUGE_DETECTED: "SIM_GOUGE_DETECTED",
  SIM_MACHINE_LIMIT_VIOLATED: "SIM_MACHINE_LIMIT_VIOLATED",
  SIM_RESIDUAL_STOCK_EXCEEDED: "SIM_RESIDUAL_STOCK_EXCEEDED",
  SIM_RUN_FAILED: "SIM_RUN_FAILED",

  // ---- NC ----
  NC_POST_FAILED: "NC_POST_FAILED",
  NC_VALIDATION_FAILED: "NC_VALIDATION_FAILED",
  NC_MACHINE_LIMIT_EXCEEDED: "NC_MACHINE_LIMIT_EXCEEDED",
  NC_UNKNOWN_COMMAND: "NC_UNKNOWN_COMMAND",

  // ---- MASTER DATA ----
  MASTER_DATA_NOT_FOUND: "MASTER_DATA_NOT_FOUND",
  MASTER_DATA_VERSION_CONFLICT: "MASTER_DATA_VERSION_CONFLICT",

  // ---- JOB ----
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  JOB_STATE_INVALID: "JOB_STATE_INVALID",
  JOB_ALREADY_EXISTS: "JOB_ALREADY_EXISTS",
  JOB_IDEMPOTENCY_CONFLICT: "JOB_IDEMPOTENCY_CONFLICT",
  JOB_CANCELLED: "JOB_CANCELLED",
  JOB_EXECUTION_FAILED: "JOB_EXECUTION_FAILED",
  RELEASE_NOT_FOUND: "RELEASE_NOT_FOUND",
  RELEASE_STATE_INVALID: "RELEASE_STATE_INVALID",

  // ---- PART（零件解析流水线）----
  PART_NOT_FOUND: "PART_NOT_FOUND",
  PART_STATE_INVALID: "PART_STATE_INVALID",
  PART_ANALYSIS_FAILED: "PART_ANALYSIS_FAILED",
  PART_MESH_NOT_FOUND: "PART_MESH_NOT_FOUND",

  // ---- AI ----
  AI_PROVIDER_FAILED: "AI_PROVIDER_FAILED",
  AI_OUTPUT_INVALID: "AI_OUTPUT_INVALID",
  AI_SCHEMA_VIOLATION: "AI_SCHEMA_VIOLATION",
  AI_TIMEOUT: "AI_TIMEOUT",

  // ---- SYSTEM ----
  SYSTEM_INTERNAL: "SYSTEM_INTERNAL",
  SYSTEM_UPSTREAM_UNAVAILABLE: "SYSTEM_UPSTREAM_UNAVAILABLE",
  SYSTEM_RATE_LIMITED: "SYSTEM_RATE_LIMITED",
  SYSTEM_VALIDATION: "SYSTEM_VALIDATION",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type ErrorSeverity = "INFO" | "WARNING" | "ERROR" | "BLOCKER";

export interface ApiErrorOptions {
  code: ErrorCode;
  message: string;
  /** 当前阶段/组件，如 "geometry"、"simulation" */
  stage?: string;
  details?: Record<string, unknown>;
  severity?: ErrorSeverity;
  /** 是否可重试（transient network / worker crash 等） */
  retryable?: boolean;
  /** HTTP 状态码 */
  status?: number;
}

const DEFAULT_STATUS: Partial<Record<string, number>> = {
  AUTH_UNAUTHORIZED: 401,
  AUTH_TOKEN_EXPIRED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  AUTH_FORBIDDEN: 403,
  AUTH_TENANT_MISMATCH: 403,
  FILE_NOT_FOUND: 404,
  FILE_TOO_LARGE: 413,
  FILE_INVALID_TYPE: 415,
  CAD_UNSUPPORTED_FORMAT: 415,
  MASTER_DATA_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  JOB_STATE_INVALID: 409,
  JOB_IDEMPOTENCY_CONFLICT: 409,
  MASTER_DATA_VERSION_CONFLICT: 409,
  PART_NOT_FOUND: 404,
  PART_MESH_NOT_FOUND: 404,
  PART_STATE_INVALID: 409,
  CAM_REVISION_NOT_FOUND: 404,
  CAM_FEATURE_NOT_FOUND: 404,
  CAM_TOOLPATH_GENERATION_FAILED: 422,
  RELEASE_NOT_FOUND: 404,
  RELEASE_STATE_INVALID: 409,
  SYSTEM_RATE_LIMITED: 429,
  SYSTEM_VALIDATION: 422,
};

/**
 * 业务错误模型。每个错误必须携带 error_code / stage / message /
 * technical_detail / recommended_actions / retryable / request_id（见架构文档 §42）。
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly stage?: string;
  readonly details: Record<string, unknown>;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly status: number;
  /** 由请求链路上层注入 */
  requestId?: string;

  constructor(opts: ApiErrorOptions) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.stage = opts.stage;
    this.details = opts.details ?? {};
    this.severity = opts.severity ?? (opts.retryable ? "WARNING" : "ERROR");
    this.retryable = opts.retryable ?? false;
    this.status = opts.status ?? DEFAULT_STATUS[opts.code] ?? 500;
  }

  /** 转为 API 统一错误响应体（03_API接口规范 §2） */
  toResponse(requestId?: string): {
    error: {
      code: ErrorCode;
      message: string;
      stage?: string;
      details: Record<string, unknown>;
      retryable: boolean;
      request_id: string | undefined;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        stage: this.stage,
        details: this.details,
        retryable: this.retryable,
        request_id: requestId ?? this.requestId,
      },
    };
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** 校验输入失败时使用的快捷构造 */
export function validationError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError({
    code: ErrorCodes.SYSTEM_VALIDATION,
    message,
    details,
    retryable: false,
  });
}
