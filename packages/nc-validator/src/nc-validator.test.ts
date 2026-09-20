/** nc-validator 单元测试：Parser 语法 / 四层校验 / 分层报告 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { postProcess, FANUC_PROFILE } from "@ai-cam/post-core";
import { simulate } from "@ai-cam/stock-sim";
import { parseNc, motionPoints } from "./parser.js";
import { validateNc } from "./validator.js";

describe("parser", () => {
  it("解析 G01 行并做坐标延续", () => {
    const nc = parseNc("N10 G21 G17 G90 G94\nN20 G00 X10. Y20. Z5.\nN30 G01 Z0. F600\nN40 G01 X30.\nN50 M30\n");
    expect(nc.errors).toEqual([]);
    expect(nc.motions.length).toBe(3);
    expect(nc.points[0]).toMatchObject({ x: 10, y: 20, z: 5 });
    expect(nc.points[1]).toMatchObject({ x: 10, y: 20, z: 0 }); // Z 延续 X/Y
    expect(nc.points[2]).toMatchObject({ x: 30, y: 20, z: 0 }); // X 变化 Y/Z 延续
  });

  it("无法解析行报错", () => {
    const nc = parseNc("N10 G01 X10.\nthis is not nc\n");
    expect(nc.errors.length).toBeGreaterThan(0);
  });
});

describe("validateNc（box 全流程）", () => {
  const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
  const part = parseWorkerOutput(raw);
  const features = buildFeatureGraph(part, "box").features;
  const { cam } = planPart(part, features);
  const sim = simulate({ cam, partVolumeMm3: part.volume_mm3, frameStep: 4 });
  const nc = postProcess(cam, FANUC_PROFILE);

  it("四层全 PASS", () => {
    const rep = validateNc({ cam, ncText: nc.text, programNumber: nc.program_number, simulation: sim });
    expect(rep.schema_version).toBe("1.0.0");
    expect(rep.status).toBe("PASS");
    expect(rep.layers.map((l) => l.layer)).toEqual(["PARSER", "SEMANTIC", "MACHINE", "SIMULATION"]);
    for (const l of rep.layers) expect(l.status).toBe("PASS");
  });

  it("篡改 NC（错误坐标）→ SEMANTIC FAIL", () => {
    const bad = nc.text.replace(/X-4\./g, "X-99.").replace(/X-4/g, "X-99");
    const rep = validateNc({ cam, ncText: bad, programNumber: nc.program_number, simulation: sim });
    expect(rep.status).toBe("FAIL");
    expect(rep.layers.find((l) => l.layer === "SEMANTIC")!.status).toBe("FAIL");
  });

  it("缺少 M30 → SEMANTIC FAIL", () => {
    const bad = nc.text.replace("M30", "M05");
    const rep = validateNc({ cam, ncText: bad, programNumber: nc.program_number, simulation: sim });
    expect(rep.layers.find((l) => l.layer === "SEMANTIC")!.status).toBe("FAIL");
  });

  it("NC 运动点与 IR 完全一致", () => {
    const parsed = parseNc(nc.text);
    const ncPts = motionPoints(parsed);
    const irPts: Array<{ x: number; y: number; z: number }> = [];
    for (const op of cam.operations) {
      const tp = cam.toolpaths!.find((t) => t.operation_id === op.id)!;
      for (const m of tp.moves) irPts.push({ x: m.x, y: m.y, z: m.z });
    }
    expect(ncPts.length).toBe(irPts.length);
    for (let i = 0; i < ncPts.length; i++) {
      expect(Math.hypot(ncPts[i].x - irPts[i].x, ncPts[i].y - irPts[i].y, ncPts[i].z - irPts[i].z)).toBeLessThan(1e-2);
    }
  });
});
