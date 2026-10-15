import { describe, expect, it } from "vitest";
import { ApiError, ErrorCodes, isApiError, type ErrorCode } from "./error-codes.js";

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
    expect(err.status).toBe(409);
  });

  it("recommended_actions 默认为空数组", () => {
    const err = new ApiError({ code: ErrorCodes.SYSTEM_INTERNAL, message: "x" });
    expect(err.recommended_actions).toEqual([]);
  });

  it("recommended_actions 可在构造时传入", () => {
    const err = new ApiError({
      code: ErrorCodes.CAM_PARAMETER_OUT_OF_RANGE,
      message: "feed rate too high",
      recommended_actions: ["降低进给率", "检查刀具负载"],
    });
    expect(err.recommended_actions).toEqual(["降低进给率", "检查刀具负载"]);
  });

  it("CAM/SIM/NC 码有合理的非 500 HTTP 映射", () => {
    const cases: Array<[ErrorCode, number]> = [
      [ErrorCodes.CAM_PARAMETER_OUT_OF_RANGE, 422],
      [ErrorCodes.CAM_IR_INVALID, 422],
      [ErrorCodes.CAM_TOOL_REACH_FAILED, 409],
      [ErrorCodes.CAD_PARSE_FAILED, 422],
      [ErrorCodes.CAM_NO_VALID_SETUP, 422],
      [ErrorCodes.SIM_COLLISION_DETECTED, 409],
      [ErrorCodes.SIM_GOUGE_DETECTED, 409],
      [ErrorCodes.SIM_MACHINE_LIMIT_VIOLATED, 409],
      [ErrorCodes.SIM_RESIDUAL_STOCK_EXCEEDED, 422],
      [ErrorCodes.NC_VALIDATION_FAILED, 422],
      [ErrorCodes.NC_MACHINE_LIMIT_EXCEEDED, 409],
      [ErrorCodes.NC_UNKNOWN_COMMAND, 422],
    ];
    for (const [code, expected] of cases) {
      const status = new ApiError({ code, message: "x" }).status;
      expect(status).not.toBe(500);
      expect(status).toBe(expected);
    }
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
