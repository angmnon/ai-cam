import { describe, expect, it } from "vitest";
import { autoVoxelSize, simulate } from "../src/simulation.js";
import { planPart } from "@ai-cam/cam-kernel";

function camLike(maxL: number) {
  return { stock: { origin: { x: 0, y: 0, z: 0 }, dimensions: { x: maxL, y: maxL * 0.6, z: maxL * 0.25 } } };
}

describe("stock-sim 分辨率自适应（H-4）", () => {
  it("小零件用 2mm 体素", () => {
    expect(autoVoxelSize(camLike(100) as never)).toBe(2);
  });
  it("中等零件 3mm", () => {
    expect(autoVoxelSize(camLike(200) as never)).toBe(3);
  });
  it("大零件 4-5mm 降档", () => {
    expect(autoVoxelSize(camLike(400) as never)).toBe(4);
    expect(autoVoxelSize(camLike(600) as never)).toBe(5);
  });
  it("缺省毛坯时回退 2mm", () => {
    expect(autoVoxelSize({ stock: undefined } as never)).toBe(2);
  });
  it("未传 voxelSize 时 simulate 使用自适应", () => {
    // 用最小规划件验证 simulate 可运行且 voxel 为自适应值
    const part = { file: "x.step", status: "ok", units: "mm", healing_valid: true, solid_count: 1, volume_mm3: 100_000, bbox_mm: { min: [0, 0, 0], max: [50, 50, 40] }, face_count: 6, faces: [] };
    const features = [{ id: "f1", type: "POCKET", confidence: 0.95, source_face_ids: [], bbox: { min: { x: 10, y: 10, z: 0 }, max: { x: 30, y: 30, z: 8 } }, accessible_directions: ["+Z"], dimensions: { width_mm: 20, length_mm: 20, depth_mm: 8 }, recognized_by: "T", recognizer_version: "v" }];
    const plan = planPart(part as never, features as never, {});
    const sim = simulate({ cam: plan.cam, partVolumeMm3: 100_000 });
    expect(sim.voxel_size_mm).toBeGreaterThanOrEqual(2);
  });
});
