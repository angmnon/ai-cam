/**
 * P2-30 JobStatus 状态机单测：
 *  - 合法迁移链 PENDING→PLANNED→SIMULATED→POSTED→VALIDATED→RELEASED 走通；
 *  - 非法迁移（如 VALIDATED→PLANNED）抛 IllegalJobStatusTransitionError；
 *  - 失败路径转 FAILED（各阶段均可 → FAILED，且 FAILED 为终态）。
 */
import { describe, expect, it } from "vitest";
import {
  JOB_STATUS_TRANSITIONS,
  IllegalJobStatusTransitionError,
  createJobStatusMachine,
  transitionJobStatus,
  type JobStatus,
} from "./job-status.js";

describe("P2-30 JobStatus 状态机", () => {
  it("合法迁移链走通：PENDING→PLANNED→SIMULATED→POSTED→VALIDATED→RELEASED", () => {
    let s: JobStatus = "PENDING";
    s = transitionJobStatus(s, "PLANNED");
    expect(s).toBe("PLANNED");
    s = transitionJobStatus(s, "SIMULATED");
    expect(s).toBe("SIMULATED");
    s = transitionJobStatus(s, "POSTED");
    expect(s).toBe("POSTED");
    s = transitionJobStatus(s, "VALIDATED");
    expect(s).toBe("VALIDATED");
    s = transitionJobStatus(s, "RELEASED");
    expect(s).toBe("RELEASED");
  });

  it("非法迁移（VALIDATED→PLANNED）抛 IllegalJobStatusTransitionError", () => {
    let s: JobStatus = "PENDING";
    s = transitionJobStatus(s, "PLANNED");
    s = transitionJobStatus(s, "SIMULATED");
    s = transitionJobStatus(s, "POSTED");
    s = transitionJobStatus(s, "VALIDATED");
    expect(() => transitionJobStatus(s, "PLANNED")).toThrow(IllegalJobStatusTransitionError);
    // 其它回退也非法：RELEASED 不能回退、SIMULATED 不能跳 POSTED 之后
    expect(() => transitionJobStatus("RELEASED", "VALIDATED")).toThrow(IllegalJobStatusTransitionError);
    expect(() => transitionJobStatus("SIMULATED", "POSTED")).not.toThrow();
  });

  it("失败路径转 FAILED：任意非终态阶段均可 → FAILED，且 FAILED/RELEASED 为终态无出边", () => {
    // 各阶段失败均可迁移到 FAILED
    expect(transitionJobStatus("PENDING", "FAILED")).toBe("FAILED");
    expect(transitionJobStatus("PLANNED", "FAILED")).toBe("FAILED");
    expect(transitionJobStatus("SIMULATED", "FAILED")).toBe("FAILED");
    expect(transitionJobStatus("POSTED", "FAILED")).toBe("FAILED");
    expect(transitionJobStatus("VALIDATED", "FAILED")).toBe("FAILED");
    // 终态：FAILED / RELEASED 不能再迁移
    expect(() => transitionJobStatus("FAILED", "PLANNED")).toThrow();
    expect(() => transitionJobStatus("FAILED", "RELEASED")).toThrow();
    expect(() => transitionJobStatus("RELEASED", "FAILED")).toThrow();
  });

  it("createJobStatusMachine：初始 PENDING，链式 advance 推进，非法迁移抛错", () => {
    const sm = createJobStatusMachine();
    expect(sm.current).toBe("PENDING");
    sm.advance("PLANNED");
    sm.advance("SIMULATED");
    sm.advance("POSTED");
    expect(sm.current).toBe("POSTED");
    // 非法回退：POSTED 不能直接跳 PENDING
    expect(() => sm.advance("PENDING")).toThrow(IllegalJobStatusTransitionError);
    // 推进至终态
    sm.advance("VALIDATED");
    sm.advance("RELEASED");
    expect(sm.current).toBe("RELEASED");
  });

  it("合法迁移表与主链一致：每个中间状态指向其后续阶段", () => {
    expect(JOB_STATUS_TRANSITIONS.PENDING).toContain("PLANNED");
    expect(JOB_STATUS_TRANSITIONS.PLANNED).toContain("SIMULATED");
    expect(JOB_STATUS_TRANSITIONS.SIMULATED).toContain("POSTED");
    expect(JOB_STATUS_TRANSITIONS.POSTED).toContain("VALIDATED");
    expect(JOB_STATUS_TRANSITIONS.VALIDATED).toContain("RELEASED");
    // 所有中间状态均允许失败出口 → FAILED
    for (const mid of ["PENDING", "PLANNED", "SIMULATED", "POSTED", "VALIDATED"] as const) {
      expect(JOB_STATUS_TRANSITIONS[mid]).toContain("FAILED");
    }
    // 终态无出边
    expect(JOB_STATUS_TRANSITIONS.RELEASED).toEqual([]);
    expect(JOB_STATUS_TRANSITIONS.FAILED).toEqual([]);
  });
});
