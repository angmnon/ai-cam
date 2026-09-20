import { describe, expect, it } from "vitest";
import { EventTypes, makeCloudEvent } from "./cloud-event.js";
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
