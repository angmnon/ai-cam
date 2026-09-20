import { describe, expect, it } from "vitest";
import { checkShopFloorNc } from "../src/index.js";

const SAFE = `O1001 (PLATE_A1)
N10 G90 G54 G17 G21
N20 G0 Z30.0
N30 G0 X0 Y0
N40 G1 Z5.0 F200
N50 G1 X50 F600
N60 M01
N70 G0 Z30.0
N80 M30`;

describe("shop-floor-check 工厂零件验证", () => {
  it("安全程序通过", () => {
    const r = checkShopFloorNc(SAFE, { requirePartComment: true });
    expect(r.status).toBe("PASS");
    expect(r.stats.rapid_blocks).toBeGreaterThanOrEqual(2);
    expect(r.stats.m01_blocks).toBe(1);
    expect(r.program).toBe("O1001");
  });

  it("缺结束码 FAIL", () => {
    const nc = SAFE.replace("M30", "");
    expect(checkShopFloorNc(nc).status).toBe("FAIL");
  });

  it("切削后未抬安全高度直接空运行 FAIL", () => {
    const nc = SAFE.replace("N60 M01", "N60 G0 Z0.5");
    const r = checkShopFloorNc(nc);
    expect(r.items.some((i) => i.code === "SFC-0103")).toBe(true);
  });

  it("低于允许下限 FAIL", () => {
    const nc = SAFE.replace("N50 G1 X50 F600", "N50 G1 Z-2.0 F600");
    expect(checkShopFloorNc(nc).status).toBe("FAIL");
  });

  it("无注释仅 WARN（非必须时不阻断）", () => {
    const nc = SAFE.replace("(PLATE_A1) ", "");
    const r = checkShopFloorNc(nc);
    expect(r.status).not.toBe("FAIL");
  });
});
