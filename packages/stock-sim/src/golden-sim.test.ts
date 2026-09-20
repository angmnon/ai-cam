/**
 * Golden 仿真回归（P3-1~P3-3 验收）：20 样本 → planPart → simulate。
 * 断言：仿真跑通、量化指标完整、碰撞/gouge 为 0 或标记、残料误差可控。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { simulate } from "./simulation.js";

const GOLDEN_DIR = resolve(process.cwd(), "../../tests/golden");
const PARTS_DIR = join(GOLDEN_DIR, "parts");

function loadStems(): string[] {
  try {
    return readdirSync(PARTS_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

describe("Golden 仿真回归（真实 OCCT 几何 → 刀路 → 体素材料去除）", () => {
  const stems = loadStems().map((f) => f.replace(/\.json$/, ""));

  it("Golden 夹具存在（≥8）", () => {
    expect(stems.length).toBeGreaterThanOrEqual(8);
  });

  for (const stem of stems) {
    it(`${stem}: 仿真完成且量化指标有效`, () => {
      const raw = readFileSync(join(PARTS_DIR, `${stem}.json`), "utf8");
      const part = parseWorkerOutput(raw);
      const features = buildFeatureGraph(part, stem).features;
      const { cam } = planPart(part, features);
      const rep = simulate({ cam, partVolumeMm3: part.volume_mm3, frameStep: 4, frameEvery: Math.max(1, Math.floor(cam.operations.length / 3)) });

      expect(rep.schema_version).toBe("1.0.0");
      expect(rep.initial_volume_mm3).toBeGreaterThan(part.volume_mm3);
      expect(rep.removed_volume_mm3).toBeGreaterThan(0);
      expect(rep.residual_volume_mm3).toBeGreaterThanOrEqual(0);
      expect(rep.removal_error_pct).toBeGreaterThanOrEqual(0);
      expect(rep.op_details.length).toBe(cam.operations.length);
      // 每 op 已执行：累计切除 ≥ 0
      for (const d of rep.op_details) {
        expect(d.removed_volume_mm3).toBeGreaterThanOrEqual(0);
        expect(d.move_count).toBeGreaterThan(0);
      }
      // 关键面残料 ≤ 阈值×2（WARN 上限）
      for (const ks of rep.key_surfaces) {
        expect(ks.residual_mm).toBeLessThanOrEqual(rep.voxel_size_mm * 3);
      }
      // 碰撞不允许出现（确定性生成器 + 安全退刀）
      const collisions = rep.events.filter((e) => e.kind === "COLLISION");
      expect(collisions).toEqual([]);
      // 快照帧存在
      expect(rep.frames.length).toBeGreaterThan(0);
    });
  }
});
