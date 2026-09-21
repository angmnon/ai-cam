import { describe, expect, it, vi, afterEach } from "vitest";
import { EventTypes, isEventType, makeCloudEvent, newId } from "./cloud-event.js";
import { formatSse } from "./sse.js";

describe("event-schema", () => {
  it("构造完整 CloudEvent", () => {
    const evt = makeCloudEvent(
      "com.aicam.job-service",
      EventTypes.JOB_PROGRESS,
      "job_1",
      { status: "PARSING", progress: 25, updated_at: new Date().toISOString() },
    );
    expect(evt.specversion).toBe("1.0");
    expect(evt.id).toMatch(/^evt_/);
    expect(evt.source).toBe("com.aicam.job-service");
    expect(evt.type).toBe("job.progress");
    expect(evt.subject).toBe("job_1");
    expect(evt.datacontenttype).toBe("application/json");
  });

  it("SSE 帧编码符合协议", () => {
    const evt = makeCloudEvent("com.aicam.job-service", EventTypes.JOB_CREATED, "job_1", {
      job_id: "job_1",
    });
    const frame = formatSse(evt);
    expect(frame.startsWith(`event: job.created\n`)).toBe(true);
    expect(frame).toContain(`\ndata: `);
    expect(frame.endsWith(`\n\n`)).toBe(true);
    // data 必须是合法 JSON
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
    expect(() => JSON.parse(dataLine.slice(6))).not.toThrow();
  });
});

describe("event type 严格枚举 (P3-04)", () => {
  it("EventTypes 中所有值均通过 isEventType", () => {
    for (const v of Object.values(EventTypes)) {
      expect(isEventType(v)).toBe(true);
    }
  });

  it("非法值被 isEventType 拒绝", () => {
    expect(isEventType("job.foo")).toBe(false);
    expect(isEventType("")).toBe(false);
    expect(isEventType(undefined)).toBe(false);
    expect(isEventType(123)).toBe(false);
  });

  it("makeCloudEvent 对非法 type 抛错", () => {
    expect(() =>
      // @ts-expect-error 故意传入非法类型，验证运行时守卫
      makeCloudEvent("com.aicam.job-service", "job.not.a.real.event", "job_1"),
    ).toThrow(/invalid cloud event type/);
  });
});

describe("newId crypto 兜底 (P3-05)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("正常环境返回 prefix 前缀 ID", () => {
    const id = newId("evt");
    expect(id.startsWith("evt_")).toBe(true);
    expect(id.length).toBeGreaterThan(4);
  });

  it("globalThis.crypto 缺失时走兜底仍可用", () => {
    vi.stubGlobal("crypto", undefined);
    const a = newId("evt");
    const b = newId("evt");
    expect(a.startsWith("evt_")).toBe(true);
    expect(b.startsWith("evt_")).toBe(true);
    // 兜底 ID 不应退化为纯 uuid 形态，但彼此不同（时间戳+随机字节）
    expect(a).not.toBe(b);
  });

  it("globalThis.crypto.randomUUID 缺失时走兜底", () => {
    vi.stubGlobal("crypto", {});
    const id = newId("evt");
    expect(id.startsWith("evt_")).toBe(true);
  });
});
