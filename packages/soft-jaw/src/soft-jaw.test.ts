/** 软爪生成测试（P5-3） */
import { describe, expect, it } from "vitest";
import { designSoftJaw, toObj, estimateVolume } from "./soft-jaw.js";

const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 50, z: 30 } };

describe("参数化软爪", () => {
  it("X 夹持：槽宽=零件 Y 厚，槽深=夹持深度，爪体包络零件", () => {
    const jaw = designSoftJaw({ partBBox: box, clampDir: "X", clampDepthMm: 15, wallThicknessMm: 20 });
    expect(jaw.clamp_dir).toBe("+X");
    expect(jaw.params.slot_width_mm).toBe(50);
    expect(jaw.params.slot_depth_mm).toBe(15);
    expect(jaw.params.length_mm).toBe(90); // 50 + 2*20
    expect(jaw.params.height_mm).toBe(50); // 30 + 20
    expect(jaw.params.fillet_mm).toBe(3);
    expect(jaw.params.material).toBe("6061-T6");
  });

  it("Y 夹持：槽宽=零件 X 厚", () => {
    const jaw = designSoftJaw({ partBBox: box, clampDir: "Y" });
    expect(jaw.clamp_dir).toBe("+Y");
    expect(jaw.params.slot_width_mm).toBe(80);
  });

  it("OBJ 导出为确定性文本（顶点/面数量稳定）", () => {
    const jaw = designSoftJaw({ partBBox: box, clampDir: "X" });
    const obj = toObj(jaw);
    expect(obj.startsWith("# SoftJaw")).toBe(true);
    expect(obj.split("\n").filter((l) => l.startsWith("v ")).length).toBe(16);
    expect(obj.split("\n").filter((l) => l.startsWith("f ")).length).toBe(12);
  });

  it("体积估算 = 外廓体积 - 槽体积", () => {
    const jaw = designSoftJaw({ partBBox: box, clampDir: "X", clampDepthMm: 15, wallThicknessMm: 20 });
    const expected = 90 * 35 * 50 - 15 * 50 * 50;
    expect(estimateVolume(jaw)).toBeCloseTo(expected, 6);
  });
});
