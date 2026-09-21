/** shop-floor-check 单元测试（P3-21）：tokenize 对"地址字母 + 空格 + 带符号数值"的解析 */
import { describe, expect, it } from "vitest";
import { checkShopFloorNc, FLOOR_CHECK_MIN_Z_OFFSET_MM } from "./check.js";

describe("tokenize：地址字母与带符号数值间的空格", () => {
  it("Z -0.5（空格负号）应被识别为 Z=-0.5，而非把 -0.5 当独立 token", () => {
    // 旧 tokenize 按空白切分后 Z 是裸字母、Number("")=NaN → min_cut_z_mm 丢失为 null。
    const nc = [
      "O1000 (TEST PART)",
      "G21 G90",
      "G00 Z20.",
      "G01 Z -0.5 F600",
      "G00 Z20.",
      "M30",
    ].join("\n");
    const report = checkShopFloorNc(nc);
    // 关键断言：最低切削 Z 必须解析成 -0.5，而不是 null/NaN
    expect(report.stats.min_cut_z_mm).toBe(-0.5);
    expect(report.status).toBe("PASS");
  });

  it("多行空格负号 X/Y/Z 均应合并解析", () => {
    const nc = [
      "O1001 (TEST PART)",
      "G90",
      "G00 X20. Y20. Z20.",
      "G01 X -10. Y -10. Z -0.5 F600",
      "G00 Z20.",
      "M30",
    ].join("\n");
    const report = checkShopFloorNc(nc);
    // Z 模态/最低切削值必须正确取到 -0.5
    expect(report.stats.min_cut_z_mm).toBe(-0.5);
  });

  it("无空格的 Z-0.5 仍按原样解析（回归，不破坏既有格式）", () => {
    const nc = [
      "O1002 (TEST PART)",
      "G90",
      "G00 Z20.",
      "G01 Z-0.5 F600",
      "G00 Z20.",
      "M30",
    ].join("\n");
    const report = checkShopFloorNc(nc);
    expect(report.stats.min_cut_z_mm).toBe(-0.5);
  });

  it("Z 低于允许下限仍能触发 SFC-0104（证明解析到的是真实数值而非 NaN）", () => {
    // 钻穿到 -1.0，低于默认下限 FLOOR_CHECK_MIN_Z_OFFSET_MM(-0.6)
    const nc = [
      "O1003 (TEST PART)",
      "G90",
      "G00 Z20.",
      "G01 Z -1.0 F600",
      "G00 Z20.",
      "M30",
    ].join("\n");
    const report = checkShopFloorNc(nc);
    expect(report.stats.min_cut_z_mm).toBe(-1.0);
    expect(report.status).toBe("FAIL");
    expect(report.items.some((i) => i.code === "SFC-0104")).toBe(true);
  });

  it("常量口径未变：默认下限仍为 -0.6", () => {
    expect(FLOOR_CHECK_MIN_Z_OFFSET_MM).toBe(-0.6);
  });
});
