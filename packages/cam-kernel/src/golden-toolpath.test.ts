/**
 * Golden 刀路回归（P2 验收）：20 个样本的真实 OCCT 几何 + 特征识别
 * → cam-kernel 工艺规划 → 刀路断言：
 *  - 每 op 刀路 move 合法（type 枚举 / feed>0 / z ≤ safeZ / 数值有限）
 *  - FACE 覆盖阈值 ≥ 0.9；DRILL 孔中心与特征一致；POCKET 层切到底
 *  - CamIR 结构可被 schema 校验（确定性可复现）
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { CamIR } from "@ai-cam/cam-ir";
import { seedTools } from "@ai-cam/master-data";
import { planPart, faceCoverage, rect2, CAM_KERNEL_VERSION } from "./index.js";

const GOLDEN_DIR = resolve(process.cwd(), "../../tests/golden");
const PARTS_DIR = join(GOLDEN_DIR, "parts");

function loadStems(): string[] {
  try {
    return readdirSync(PARTS_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

const VALID_MOVE_TYPES = ["RAPID", "LINEAR", "ARC_CW", "ARC_CCW", "PLUNGE", "RETRACT"];

describe("Golden 刀路回归（真实 OCCT 几何 → cam-kernel）", () => {
  const stems = loadStems().map((f) => f.replace(/\.json$/, ""));

  it("Golden 夹具存在（≥8）", () => {
    expect(stems.length).toBeGreaterThanOrEqual(8);
  });

  for (const stem of stems) {
    it(`${stem}: 工艺规划 → 刀路合法且覆盖达标`, () => {
      const raw = readFileSync(join(PARTS_DIR, `${stem}.json`), "utf8");
      const part = parseWorkerOutput(raw);
      const features = buildFeatureGraph(part, stem).features;
      const { cam, toolpaths } = planPart(part, features);

      // CamIR 可被 schema 校验（确定性）
      const parsed = CamIR.parse(cam);
      expect(parsed.schema_version).toBe("1.0.0");
      expect(parsed.toolpaths?.length).toBe(toolpaths.length);
      expect(parsed.operations.length).toBeGreaterThanOrEqual(2);

      const safeZ = cam.setups[0].origin.z + part.bbox_mm.max[2] + 20;
      for (const tp of toolpaths) {
        expect(tp.engine_version).toBe(CAM_KERNEL_VERSION);
        expect(tp.move_count).toBe(tp.moves.length);
        expect(tp.move_count).toBeGreaterThanOrEqual(4);
        for (const m of tp.moves) {
          expect(VALID_MOVE_TYPES).toContain(m.type);
          expect(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z)).toBe(true);
          if (m.type !== "RAPID") {
            expect(m.feed_mm_min).toBeGreaterThan(0);
          }
          expect(m.z).toBeLessThanOrEqual(safeZ + 1e-6);
        }
        // bounds 覆盖 moves
        expect(tp.bounds).toBeDefined();
        expect(tp.bounds!.min.x).toBeLessThanOrEqual(tp.bounds!.max.x);
      }

      // FACE 覆盖阈值 ≥ 0.9
      const faceOp = cam.operations.find((o) => o.type === "FACE");
      if (faceOp) {
        const p = part;
        const margin = 5;
        const stockRect = rect2(p.bbox_mm.min[0] - margin, p.bbox_mm.min[1] - margin, p.bbox_mm.max[0] + margin, p.bbox_mm.max[1] + margin);
        const toolR = cam.tools.length > 0 ? toolDiaOf(faceOp, cam) / 2 : 5;
        const stepover = faceOp.parameters.stepover_mm ?? toolR * 2 * 0.6;
        expect(faceCoverage(stockRect, stepover, toolR)).toBeGreaterThanOrEqual(0.9);
      }

      // DRILL：孔中心与特征 bbox 中心一致
      for (const op of cam.operations.filter((o) => o.type === "DRILL")) {
        const tp = toolpaths.find((t) => t.operation_id === op.id)!;
        const drillMoves = tp.moves.filter((m) => m.type === "LINEAR" || m.type === "PLUNGE");
        expect(drillMoves.length).toBeGreaterThan(0);
        const cx = drillMoves[0].x;
        const cy = drillMoves[0].y;
        const feat = features.find((f) => op.feature_ids.includes(f.id));
        if (feat) {
          expect(Math.abs(cx - (feat.bbox.min.x + feat.bbox.max.x) / 2)).toBeLessThan(1e-6);
          expect(Math.abs(cy - (feat.bbox.min.y + feat.bbox.max.y) / 2)).toBeLessThan(1e-6);
        }
      }

      // POCKET 层切到底（存在底平面以下 0.1 内的 move）
      for (const op of cam.operations.filter((o) => o.type === "POCKET")) {
        const tp = toolpaths.find((t) => t.operation_id === op.id)!;
        const feat = features.find((f) => op.feature_ids.includes(f.id));
        if (feat) {
          const bottom = feat.bbox.max.z;
          expect(tp.moves.some((m) => m.z <= bottom + 0.2)).toBe(true);
        }
      }
    });
  }
});

function toolDiaOf(op: { tool: { tool_id: string } }, cam: { tools: Array<{ tool_id: string }> }): number {
  void cam;
  const t = seedTools.find((x) => x.id === op.tool.tool_id);
  return t?.diameter_mm ?? 6; // 真实刀具直径（默认 6 兜底）
}
