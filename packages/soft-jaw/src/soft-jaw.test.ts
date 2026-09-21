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

  it("槽口坐标：槽深沿 X、槽宽沿 Y（Y 起始不得误用 slotD）", () => {
    const jaw = designSoftJaw({ partBBox: box, clampDir: "X", clampDepthMm: 15, wallThicknessMm: 20 });
    const { width_mm: w, length_mm: l, height_mm: h, slot_width_mm: slotW, slot_depth_mm: slotD } = jaw.params;
    const verts = toObj(jaw)
      .split("\n")
      .filter((ln) => ln.startsWith("v "))
      .map((ln) => ln.slice(2).trim().split(/\s+/).map(Number));
    expect(verts.length).toBe(16);
    // 外廓包络：X∈[0,w]，Y∈[0,l]，Z∈[0,h]
    const xs = verts.map((v) => v[0]);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(w, 6);
    // 槽深沿 X：槽底平面在 X = w - slotD（从前壁 X=w 向内切 slotD）
    const slotXBottom = w - slotD;
    expect(w - slotXBottom).toBeCloseTo(slotD, 6);
    // 槽底平面顶点恰位于 X = slotXBottom
    const bottom = verts.filter((v) => Math.abs(v[0] - slotXBottom) < 1e-6);
    expect(bottom.length).toBe(4);
    // 槽宽沿 Y：槽口 Y 区间宽度恰为 slotW，且居中
    const yEdges = bottom.map((v) => v[1]);
    const yLo = Math.min(...yEdges);
    const yHi = Math.max(...yEdges);
    expect(yHi - yLo).toBeCloseTo(slotW, 6);
    expect(yLo).toBeCloseTo((l - slotW) / 2, 6);
    expect(yHi).toBeCloseTo((l + slotW) / 2, 6);
    // 回归旧 bug：slotD 不得作为槽口 Y 起始坐标
    expect(yLo).not.toBeCloseTo(slotD, 6);
  });
});
