import { describe, expect, it } from "vitest";
import { isApiError } from "@ai-cam/error-codes";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import { recognize } from "./recognize.js";

/** 识别失败路径：空面模型必须抛 typed ApiError（PART_ANALYSIS_FAILED） */
describe("feature-engine 识别失败路径", () => {
  it("无面模型抛 typed 错误且携带 code", () => {
    const emptyPart = { faces: [] } as unknown as NormalizedPartModel;
    expect.assertions(3);
    try {
      recognize(emptyPart);
    } catch (e) {
      expect(isApiError(e)).toBe(true);
      const err = e as { code?: string };
      expect(err.code).toBe("PART_ANALYSIS_FAILED");
      expect((e as Error).message).toMatch(/no faces/);
    }
  });
});
