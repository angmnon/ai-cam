import { describe, expect, it } from "vitest";
import { ApiError, ErrorCodes, isApiError } from "./error-codes.js";

describe("error-codes", () => {
  it("错误码唯一", () => {
    const values = Object.values(ErrorCodes);
    expect(new Set(values).size).toBe(values.length);
  });

  it("ApiError 序列化为统一错误体", () => {
    const err = new ApiError({
      code: ErrorCodes.CAM_TOOL_REACH_FAILED,
      message: "No valid tool assembly can reach this feature.",
      stage: "tool-planner",
      details: { feature_id: "F102", required_reach_mm: 84, available_mm: 70 },
      retryable: false,
    });
    const body = err.toResponse("req_123");
    expect(body.error).toMatchObject({
      code: "CAM_TOOL_REACH_FAILED",
      stage: "tool-planner",
      retryable: false,
      request_id: "req_123",
    });
    expect(err.status).toBe(500);
  });

  it("默认 HTTP 状态映射", () => {
    expect(new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "x" }).status).toBe(404);
    expect(new ApiError({ code: ErrorCodes.JOB_STATE_INVALID, message: "x" }).status).toBe(409);
    expect(new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "x" }).status).toBe(401);
    expect(new ApiError({ code: ErrorCodes.SYSTEM_RATE_LIMITED, message: "x" }).status).toBe(429);
  });

  it("isApiError 判别", () => {
    expect(isApiError(new ApiError({ code: ErrorCodes.SYSTEM_INTERNAL, message: "x" }))).toBe(true);
    expect(isApiError(new Error("plain"))).toBe(false);
  });
});
