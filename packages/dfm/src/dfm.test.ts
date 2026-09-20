/** DFM 规则引擎单元测试（合成规范化模型，验证规则逻辑） */
import { describe, expect, it } from "vitest";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";
import type { Feature, FeatureGraph } from "@ai-cam/domain-schemas";
import { analyzeDfm } from "../src/index.js";

const FACE = (id: number, type: string, bbox: [number, number, number][], extra: Record<string, unknown> = {}): NormalizedPartModel["faces"][number] =>
  ({
    id,
    type: type as NormalizedPartModel["faces"][number]["type"],
    area_mm2: 100,
    bbox: { min: bbox[0], max: bbox[1] },
    center: [0, 0, 0],
    edge_count: 4,
    edges: [{ type: "LINE" as const, length_mm: 10 }],
    ...extra,
  }) as NormalizedPartModel["faces"][number];

function partWithFaces(over: Partial<NormalizedPartModel> = {}): NormalizedPartModel {
  return {
    status: "ok",
    file: "synthetic.step",
    occt_version: "7.5.1",
    units: "mm",
    healing_valid: true,
    solid_count: 1,
    bbox_mm: { min: [0, 0, 0], max: [100, 60, 30] },
    volume_mm3: 180000,
    face_count: 6,
    faces: [FACE(1, "PLANE", [[0, 0, 30], [100, 60, 30]], { normal: [0, 0, 1] })],
    edge_count: 0,
    edges: [],
    ...over,
  };
}

const bbox = (min: [number, number, number], max: [number, number, number]) => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
});

function feature(over: Partial<Feature> & { type: Feature["type"] }): Feature {
  return {
    id: "F0001",
    confidence: 0.9,
    source_face_ids: [],
    bbox: bbox([10, 10, 10], [20, 20, 20]),
    accessible_directions: ["+Z"],
    recognizer_version: "0.1.0",
    recognized_by: "ENGINE",
    ...over,
  };
}

function graphWith(features: Feature[]): FeatureGraph {
  return { part_id: "p_synth", features, edges: [], recognizer_version: "0.1.0", created_at: "2026-09-20T00:00:00Z" };
}

describe("analyzeDfm", () => {
  it("深腔 POCKET（深/宽=6）→ BLOCKER DFM-0102", () => {
    const part = partWithFaces();
    const graph = graphWith([
      feature({ type: "POCKET", bbox: bbox([30, 20, 10], [40, 30, 30]), dimensions: { length_mm: 10, width_mm: 5, depth_mm: 30 } }),
    ]);
    const report = analyzeDfm(part, graph);
    const item = report.items.find((i) => i.code === "DFM-0102");
    expect(item?.severity).toBe("BLOCKER");
    expect(item?.details?.ratio).toBeGreaterThan(5);
  });

  it("深孔（深/径=10）→ BLOCKER DFM-0103；浅孔不报", () => {
    const part = partWithFaces();
    const deep = graphWith([
      feature({ type: "HOLE_BLIND", dimensions: { diameter_mm: 3, depth_mm: 30 } }),
    ]);
    expect(analyzeDfm(part, deep).items.find((i) => i.code === "DFM-0103")?.severity).toBe("BLOCKER");

    const shallow = graphWith([
      feature({ type: "HOLE_THROUGH", accessible_directions: ["+Z", "-Z"], dimensions: { diameter_mm: 10, depth_mm: 30 } }),
    ]);
    expect(analyzeDfm(part, shallow).items.some((i) => i.code === "DFM-0103")).toBe(false);
  });

  it("薄壁（特征距边缘 1mm）→ WARNING DFM-0104", () => {
    const part = partWithFaces();
    const graph = graphWith([
      feature({ type: "POCKET", bbox: bbox([0, 25, 10], [2, 35, 30]), dimensions: { length_mm: 2, width_mm: 10, depth_mm: 20 } }),
    ]);
    expect(analyzeDfm(part, graph).items.find((i) => i.code === "DFM-0104")?.severity).toBe("WARNING");
  });

  it("不可访问特征 → BLOCKER DFM-0107", () => {
    const part = partWithFaces();
    const graph = graphWith([feature({ type: "POCKET", accessible_directions: [] })]);
    expect(analyzeDfm(part, graph).items.find((i) => i.code === "DFM-0107")?.severity).toBe("BLOCKER");
  });

  it("倒扣面（朝下非底面）→ BLOCKER DFM-0106；零件底面不报", () => {
    const part = partWithFaces({
      faces: [
        FACE(1, "PLANE", [[0, 0, 30], [100, 60, 30]], { normal: [0, 0, 1] }),
        FACE(2, "PLANE", [[20, 20, 15], [30, 30, 15]], { normal: [0, 0, -1] }),
      ],
    });
    expect(analyzeDfm(part, graphWith([])).items.find((i) => i.code === "DFM-0106")?.severity).toBe("BLOCKER");

    const withBottom = partWithFaces({
      faces: [
        FACE(1, "PLANE", [[0, 0, 30], [100, 60, 30]], { normal: [0, 0, 1] }),
        FACE(2, "PLANE", [[0, 0, 0], [100, 60, 0]], { normal: [0, 0, -1] }),
      ],
    });
    expect(analyzeDfm(withBottom, graphWith([])).items.some((i) => i.code === "DFM-0106")).toBe(false);
  });

  it("小特征（<Ø6 刀具）→ INFO DFM-0101", () => {
    const part = partWithFaces();
    const graph = graphWith([
      feature({ type: "STEP", bbox: bbox([10, 10, 10], [12, 20, 20]), dimensions: { length_mm: 2, width_mm: 10, height_mm: 10 } }),
    ]);
    expect(analyzeDfm(part, graph).items.find((i) => i.code === "DFM-0101")?.severity).toBe("INFO");
  });
});
