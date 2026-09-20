import { describe, expect, it } from "vitest";
import { JobStatuses } from "./job.js";
import {
  ALLOWED_TRANSITIONS,
  StateTransitionError,
  assertTransition,
  canTransition,
} from "./state-machine.js";

describe("job state machine", () => {
  it("所有状态都有定义（含迁移表完整）", () => {
    for (const s of JobStatuses) {
      expect(ALLOWED_TRANSITIONS[s]).toBeDefined();
    }
  });

  it("合法正向链路可推进", () => {
    const chain = [
      "DRAFT",
      "UPLOADING",
      "PARSING",
      "ANALYZING",
      "PLANNING",
      "GENERATING_TOOLPATH",
      "SIMULATING",
      "VALIDATING",
      "READY_FOR_REVIEW",
      "APPROVED",
      "RELEASED",
    ] as const;
    for (let i = 0; i < chain.length - 1; i++) {
      expect(canTransition(chain[i], chain[i + 1])).toBe(true);
    }
  });

  it("非法跳转被拒绝（如 DRAFT -> RELEASED）", () => {
    expect(canTransition("DRAFT", "RELEASED")).toBe(false);
    expect(() => assertTransition("DRAFT", "RELEASED")).toThrow(StateTransitionError);
  });

  it("仿真失败可回到刀路生成重试", () => {
    expect(canTransition("SIMULATING", "GENERATING_TOOLPATH")).toBe(true);
    expect(canTransition("VALIDATING", "GENERATING_TOOLPATH")).toBe(true);
  });

  it("FAILED 仅可重试回 DRAFT 或取消", () => {
    expect(canTransition("FAILED", "DRAFT")).toBe(true);
    expect(canTransition("FAILED", "CANCELLED")).toBe(true);
    expect(canTransition("FAILED", "RELEASED")).toBe(false);
  });

  it("终态约束：CANCELLED 不可迁移；RELEASED 仅允许召回 BLOCKED", () => {
    for (const s of JobStatuses) {
      expect(canTransition("CANCELLED", s)).toBe(false);
    }
    for (const s of JobStatuses) {
      if (s === "BLOCKED") {
        expect(canTransition("RELEASED", s)).toBe(true); // 已发布召回
      } else {
        expect(canTransition("RELEASED", s)).toBe(false);
      }
    }
  });

  it("审查相关状态流转符合预期", () => {
    expect(canTransition("READY_FOR_REVIEW", "PLANNING")).toBe(true); // 打回重规划
    expect(canTransition("READY_FOR_REVIEW", "BLOCKED")).toBe(true);
    expect(canTransition("NEEDS_ENGINEER_REVIEW", "READY_FOR_REVIEW")).toBe(true);
    expect(canTransition("BLOCKED", "READY_FOR_REVIEW")).toBe(true);
  });
});
