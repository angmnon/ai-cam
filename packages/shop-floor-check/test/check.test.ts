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

  it("P2-28 '抬刀-暂停-再抬刀'序列不被误判（部分抬刀后经 M01 再抬到安全高度 → 不报 SFC-0103）", () => {
    // 切削 Z5 → G0 Z10（部分抬刀，未到安全高度 20）→ M01 暂停 → G0 Z30（再抬到安全高度）
    const nc =
      "O1002 (PLATE_B2)\n" +
      "N10 G90 G54 G17 G21\n" +
      "N20 G0 Z30.0\n" +
      "N30 G0 X0 Y0\n" +
      "N40 G1 Z5.0 F200\n" +
      "N50 G1 X50 F600\n" +
      "N60 G0 Z10.0\n" +
      "N65 M01\n" +
      "N70 G0 Z30.0\n" +
      "N80 M30";
    const r = checkShopFloorNc(nc);
    expect(r.items.some((i) => i.code === "SFC-0103")).toBe(false);
  });
});
