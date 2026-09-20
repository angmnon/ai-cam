/**
 * Golden 回归测试（M1 验收口径）
 * 夹具：tests/golden/parts/<stem>.json —— geometry_worker 对 step_generator 生成的
 *       AP203 样本的真实 OCCT 输出（Docker 生成并提交）。
 * 期望：tests/golden/expected/<stem>.json —— 解析几何精确值（BBox 误差 < 0.01mm，
 *       体积误差 < 0.5%，solid_count/healing 精确）。
 * 特征期望：按零件设计意图断言特征类型/尺寸/可访问方向。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkerOutput, NormalizedPartModel } from "@ai-cam/geometry-schema";
import { buildFeatureGraph, recognize } from "../src/index.js";
import { analyzeDfm } from "@ai-cam/dfm";

const GOLDEN_DIR = resolve(process.cwd(), "../../tests/golden");
const PARTS_DIR = join(GOLDEN_DIR, "parts");
const EXPECTED_DIR = join(GOLDEN_DIR, "expected");

interface Expected {
  bbox_mm: { min: [number, number, number]; max: [number, number, number] };
  volume_mm3: number;
  solid_count: number;
  healing_valid: boolean;
}

interface FeatureExpect {
  type: string;
  dimensions?: Record<string, [number, number]>;
  accessible_contains?: string[];
}

const FEATURE_EXPECTATIONS: Record<string, FeatureExpect[]> = {
  box: [{ type: "OUTER_PROFILE" }],
  plate_with_hole: [
    { type: "OUTER_PROFILE" },
    { type: "HOLE_THROUGH", dimensions: { diameter_mm: [19, 21] }, accessible_contains: ["+Z", "-Z"] },
  ],
  plate_with_blind_hole: [
    { type: "OUTER_PROFILE" },
    { type: "HOLE_BLIND", dimensions: { diameter_mm: [15, 17], depth_mm: [11, 13] }, accessible_contains: ["+Z"] },
  ],
  pocket_block: [
    { type: "OUTER_PROFILE" },
    { type: "POCKET", dimensions: { length_mm: [39, 41], width_mm: [23, 25], depth_mm: [11, 13] }, accessible_contains: ["+Z"] },
  ],
  slot_block: [
    { type: "OUTER_PROFILE" },
    { type: "SLOT", dimensions: { width_mm: [11, 13], depth_mm: [9, 11] }, accessible_contains: ["+X", "-X"] },
  ],
  boss_block: [
    { type: "OUTER_PROFILE" },
    { type: "BOSS", dimensions: { length_mm: [29, 31], width_mm: [23, 25], height_mm: [11, 13] }, accessible_contains: ["+Z"] },
  ],
  stepped_block: [
    { type: "OUTER_PROFILE" },
    { type: "STEP", dimensions: { length_mm: [49, 51], width_mm: [29, 31], height_mm: [9, 11] } },
  ],
  circular_plate: [
    { type: "OUTER_PROFILE" },
    { type: "HOLE_THROUGH", dimensions: { diameter_mm: [29, 31] }, accessible_contains: ["+Z", "-Z"] },
  ],
};

function loadStems(): string[] {
  try {
    return readdirSync(PARTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

describe("Golden 回归（真实 OCCT 输出）", () => {
  const stems = loadStems();

  it("Golden 夹具存在（scripts/generate-golden 生成后提交）", () => {
    expect(stems.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of stems) {
    const stem = file.replace(/\.json$/, "");

    it(`${stem}: 解析数值符合期望（BBox<0.01mm / 体积<0.5%）`, () => {
      const expected = JSON.parse(readFileSync(join(EXPECTED_DIR, `${stem}.json`), "utf8")) as Expected;
      const raw = readFileSync(join(PARTS_DIR, file), "utf8");
      const part = parseWorkerOutput(raw);
      const model = NormalizedPartModel.parse(part);

      expect(model.units).toBe("mm");
      expect(model.status).toBe("ok");
      expect(model.solid_count).toBe(expected.solid_count);
      expect(model.healing_valid).toBe(expected.healing_valid);
      expect(model.face_count).toBeGreaterThan(0);

      const b = model.bbox_mm;
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(b.min[i] - expected.bbox_mm.min[i])).toBeLessThan(0.01);
        expect(Math.abs(b.max[i] - expected.bbox_mm.max[i])).toBeLessThan(0.01);
      }
      const volErr = Math.abs(model.volume_mm3 - expected.volume_mm3) / expected.volume_mm3;
      expect(volErr).toBeLessThan(0.005);

      // 边邻接完整性：每条边引用存在的面
      const faceIds = new Set(model.faces.map((f) => f.id));
      for (const e of model.edges) {
        expect(e.face_ids.length).toBeGreaterThanOrEqual(2);
        for (const fid of e.face_ids) expect(faceIds.has(fid)).toBe(true);
      }
    });

    const feats = FEATURE_EXPECTATIONS[stem];
    if (!feats) continue;

    it(`${stem}: 特征识别符合设计意图（${feats.map((f) => f.type).join("+")}）`, () => {
      const raw = readFileSync(join(PARTS_DIR, file), "utf8");
      const part = parseWorkerOutput(raw);
      const candidates = recognize(part);

      for (const exp of feats) {
        const hit = candidates.filter((c) => c.type === exp.type);
        expect(hit.length).toBeGreaterThanOrEqual(1);
        const target = hit[0];
        if (target && exp.dimensions) {
          for (const [key, [lo, hi]] of Object.entries(exp.dimensions)) {
            const v = target.dimensions[key];
            expect(v, `dimension ${key} of ${exp.type}`).toBeDefined();
            if (v != null) {
              expect(v).toBeGreaterThanOrEqual(lo);
              expect(v).toBeLessThanOrEqual(hi);
            }
          }
        }
        if (target && exp.accessible_contains) {
          for (const d of exp.accessible_contains) expect(target.accessible_directions).toContain(d);
        }
        expect(target?.confidence).toBeGreaterThanOrEqual(0.7);
      }

      // 每个面至多归属一个特征
      const owner = new Map<number, string>();
      for (const c of candidates) {
        for (const fid of c.source_face_ids) {
          const prev = owner.get(fid);
          expect(prev, `face #${fid} 被 ${prev} 与 ${c.id} 重复占用`).toBeUndefined();
          owner.set(fid, c.id);
        }
      }
      expect(candidates.length).toBeGreaterThanOrEqual(feats.length);
    });

    it(`${stem}: DFM 报告有效且可回归`, () => {
      const raw = readFileSync(join(PARTS_DIR, file), "utf8");
      const part = parseWorkerOutput(raw);
      const graph = buildFeatureGraph(part, stem);
      const report = analyzeDfm(part, graph);
      expect(report.part_id).toBe(stem);
      expect(report.items.length).toBe(report.summary.info + report.summary.warning + report.summary.blocker);
      for (const item of report.items) {
        expect(item.code).toMatch(/^DFM-\d{4}$/);
        expect(["INFO", "WARNING", "BLOCKER"]).toContain(item.severity);
      }
    });
  }
});
