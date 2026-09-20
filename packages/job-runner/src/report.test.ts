/** job-runner report 测试（P3-9）：工艺单/刀具清单/Setup Sheet/仿真摘要 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { runJob } from "./run.js";
import { buildJobReport } from "./report.js";

describe("buildJobReport（box）", () => {
  const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
  const part = parseWorkerOutput(raw);
  const features = buildFeatureGraph(part, "box").features;

  it("生成完整 Job 报告（工艺单/刀具/Setup/仿真摘要）", () => {
    const job = runJob({ part, partName: "box", features });
    const report = buildJobReport({ cam: job.cam, simulation: job.simulation, nc: job.nc, validation: job.validation });

    expect(report.schema_version).toBe("1.0.0");
    expect(report.program_number).toMatch(/^O\d{4}$/);
    expect(report.status).toBe("PASS");
    expect(report.validated).toBe(true);

    // summary
    expect(report.summary.machine_id).toBe("mch_vmc850");
    expect(report.summary.controller_id).toBeTruthy();
    expect(report.summary.material_id).toBeTruthy();
    expect(report.summary.operation_count).toBe(job.cam.operations.length);
    expect(report.summary.tool_count).toBe(job.cam.tools.length);

    // setup sheet
    expect(report.setup_sheet.length).toBeGreaterThanOrEqual(1);
    expect(report.setup_sheet[0].wcs).toBe("G54");

    // tool list：刀具名称/直径来自主数据
    expect(report.tool_list.length).toBeGreaterThan(0);
    for (const t of report.tool_list) {
      expect(t.tool_number).toBeGreaterThan(0);
      expect(t.operations.length).toBeGreaterThan(0);
    }

    // process sheet
    expect(report.process_sheet.length).toBe(job.cam.operations.length);
    for (const op of report.process_sheet) {
      expect(op.spindle_rpm).toBeGreaterThan(0);
      expect(op.feed_mm_min).toBeGreaterThan(0);
      expect(op.move_count).toBeGreaterThan(0);
    }

    // simulation summary
    expect(report.simulation.status).toBe("PASS");
    expect(report.simulation.removed_volume_mm3).toBeGreaterThan(0);
    expect(report.simulation.residual_volume_mm3).toBeLessThan(report.simulation.initial_volume_mm3);
    expect(Array.isArray(report.simulation.key_surfaces)).toBe(true);
    expect(Array.isArray(report.simulation.events)).toBe(true);

    // validation summary
    expect(report.validation.status).toBe("PASS");
    expect(report.validation.layers.map((l) => l.layer)).toEqual(["PARSER", "SEMANTIC", "MACHINE", "SIMULATION"]);
  });
});
