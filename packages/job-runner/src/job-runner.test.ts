/** job-runner 测试：box 全流程一键 Validated NC */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { runJob } from "./run.js";

describe("runJob（box）", () => {
  const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
  const part = parseWorkerOutput(raw);
  const features = buildFeatureGraph(part, "box").features;

  it("一键生成 Validated NC", () => {
    const job = runJob({ part, partName: "box", features });
    expect(job.validated).toBe(true);
    expect(job.pipeline.map((p) => p.stage)).toEqual(["PLAN", "SIMULATE", "POST", "VALIDATE"]);
    for (const p of job.pipeline) expect(p.status).toBe("PASS");
    expect(job.nc.program_number).toMatch(/^O\d{4}$/);
    expect(job.simulation.status).toBe("PASS");
    expect(job.validation.status).toBe("PASS");
    expect(job.cam.part_id.endsWith("box")).toBe(true);
  });

  it("ISO 方言可选", () => {
    const job = runJob({ part, partName: "box", features, dialect: "ISO_GENERIC" });
    expect(job.nc.dialect).toBe("ISO_GENERIC");
    expect(job.validated).toBe(true);
  });
});
