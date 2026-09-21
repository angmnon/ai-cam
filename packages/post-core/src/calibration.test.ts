import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { defaultCalibration, calibrateProfile } from "../src/calibration.js";
import { makeProfile, postProcess } from "../src/post.js";

describe("post-core 校准（H-3）", () => {
  it("三族默认校准存在且可复现", () => {
    for (const d of ["FANUC", "SYNTEC", "MITSUBISHI"] as const) {
      const c = defaultCalibration(d);
      expect(c.dialect).toBe(d);
      expect(c.safeHeightMm).toBeGreaterThanOrEqual(20);
      expect(c.peckIncrementMm).toBeGreaterThan(0);
    }
  });

  it("校准并入 FANUC profile 且不改变现有字段", () => {
    const profile = makeProfile("FANUC");
    const cal = defaultCalibration("FANUC");
    const p = calibrateProfile(profile, cal);
    expect(p.rapidWord).toBe("G0");
    expect(p.safeHeightMm).toBe(20);
    expect(p.toolChangeTemplate).toBe("T{tool} M06");
    expect(p.capabilities).toContain("CALIBRATED");
    expect(p.dialect).toBe("FANUC");
  });

  it("MITSUBISHI 用 G00 快速字", () => {
    const cal = defaultCalibration("MITSUBISHI");
    expect(cal.rapidWord).toBe("G00");
    expect(cal.drillCycle).toBe("G83");
  });

  it("方言不匹配抛错", () => {
    const profile = makeProfile("FANUC");
    const cal = defaultCalibration("SYNTEC");
    expect(() => calibrateProfile(profile, cal)).toThrow(/不匹配/);
  });

  it("P1-06 校准后 postProcess 输出与未校准确实不同（替换性断言）", () => {
    const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/plate_4holes.json"), "utf8");
    const part = parseWorkerOutput(raw);
    const { cam } = planPart(part, buildFeatureGraph(part, "plate_4holes").features);

    const uncal = postProcess(cam, makeProfile("SYNTEC"));
    const calProfile = calibrateProfile(makeProfile("SYNTEC"), defaultCalibration("SYNTEC"));
    const cal = postProcess(cam, calProfile);

    // 整体输出确实不同
    expect(cal.text).not.toBe(uncal.text);

    // programHeaderTemplate：未校准裸程序号，校准后渲染零件名
    expect(uncal.lines[0]).toMatch(/^O\d{4}$/);
    expect(cal.lines[0]).toMatch(/^O\d{4} \(.+\)$/);

    // rapidWord：未校准 G00，校准后 G0（其后不跟数字）
    expect(uncal.lines.some((l) => /(^|\s)G00 /.test(l))).toBe(true);
    expect(cal.lines.some((l) => /(^|\s)G0(?!\d)/.test(l))).toBe(true);
    expect(cal.lines.some((l) => /(^|\s)G00 /.test(l))).toBe(false);

    // toolChangeTemplate：未校准 M06，校准后 M6
    expect(uncal.lines.some((l) => /T\d+ M06/.test(l))).toBe(true);
    expect(cal.lines.some((l) => /T\d+ M6/.test(l))).toBe(true);
    expect(cal.lines.some((l) => /T\d+ M06/.test(l))).toBe(false);

    // drillCycle：未校准默认 G83，校准后 SYNTEC=G73 高速啄钻
    expect(uncal.text).toContain("G83");
    expect(cal.text).toContain("G73");
    expect(cal.text).not.toContain("G83");
  });
});
