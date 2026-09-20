import { describe, expect, it } from "vitest";
import { NormalizedPartModel, parseWorkerOutput } from "./part-model.js";

/** 与 cpp/geometry-core 输出的最小合法样本（box 80x50x30） */
const BOX_SAMPLE = {
  status: "ok",
  file: "/work/samples/box.step",
  occt_version: "7.5.1",
  units: "mm",
  healing_valid: true,
  solid_count: 1,
  bbox_mm: { min: [-1e-7, -1e-7, -1e-7], max: [80, 50, 30] },
  volume_mm3: 120000,
  face_count: 6,
  faces: [
    {
      id: 1,
      type: "PLANE",
      area_mm2: 1500,
      bbox: { min: [-1e-7, -1e-7, -1e-7], max: [1e-7, 50, 30] },
      normal: [-1, -0, 0],
      center: [0, 0, 0],
      edge_count: 4,
      edges: [
        { type: "LINE", length_mm: 30 },
        { type: "LINE", length_mm: 50 },
        { type: "LINE", length_mm: 30 },
        { type: "LINE", length_mm: 50 },
      ],
    },
  ],
  edge_count: 12,
  edges: [{ id: 1, type: "LINE", length_mm: 30, face_ids: [1, 3] }],
};

describe("geometry-schema NormalizedPartModel", () => {
  it("接受 worker 合法输出", () => {
    const parsed = NormalizedPartModel.parse(BOX_SAMPLE);
    expect(parsed.bbox_mm.max).toEqual([80, 50, 30]);
    expect(parsed.faces[0].normal).toEqual([-1, -0, 0]);
  });

  it("拒绝错误 status（error 对象走 parseWorkerOutput 分支）", () => {
    expect(() => NormalizedPartModel.parse({ status: "error", message: "x" })).toThrow();
  });

  it("parseWorkerOutput 能识别 worker 错误对象（抛错）", () => {
    expect(() => parseWorkerOutput(JSON.stringify({ status: "error", message: "STEP read failed" }))).toThrow(
      /geometry worker error/
    );
  });

  it("parseWorkerOutput 能解析合法输出", () => {
    const model = parseWorkerOutput(JSON.stringify(BOX_SAMPLE));
    expect(model.volume_mm3).toBe(120000);
  });
});
