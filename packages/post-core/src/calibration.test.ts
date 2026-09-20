import { describe, expect, it } from "vitest";
import { defaultCalibration, calibrateProfile } from "../src/calibration.js";
import { makeProfile } from "../src/post.js";

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
});
