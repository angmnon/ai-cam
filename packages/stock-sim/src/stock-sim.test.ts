/** stock-sim 单元测试：体素 / 材料去除 / 碰撞 / Gouge / 残料阈值 */
import { describe, expect, it } from "vitest";
import { VoxelGrid, sampleMove } from "./voxel.js";
import { simulate } from "./simulation.js";
import { planPart } from "@ai-cam/cam-kernel";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("VoxelGrid", () => {
  it("BOX 初始化体积 = 体素数 × voxel³", () => {
    const g = new VoxelGrid(0, 0, 0, 20, 20, 10);
    g.fillBox(0, 0, 0, 20, 20, 10);
    const s = g.stats();
    expect(s.filled).toBe(10 * 10 * 5);
    expect(s.volume_mm3).toBeCloseTo(20 * 20 * 10, 1);
  });

  it("圆柱扣除移除包络内体素", () => {
    const g = new VoxelGrid(0, 0, 0, 20, 20, 10);
    g.fillBox(0, 0, 0, 20, 20, 10);
    const before = g.stats().filled;
    g.cutCylinder(10, 10, 0, 10, 4); // 半径 4 圆柱从底到顶
    const after = g.stats().filled;
    expect(after).toBeLessThan(before);
    // 中心点被移除
    expect(g.anyInCylinder(10, 10, 0, 10, 1)).toBe(false);
    // 角落仍有材料
    expect(g.anyInCylinder(3, 3, 0, 10, 1)).toBe(true); // 角落体素中心 (3,3)
  });

  it("topHeightAt 返回列最高材料面", () => {
    const g = new VoxelGrid(0, 0, 0, 10, 10, 10);
    g.fillBox(0, 0, 0, 10, 10, 4);
    expect(g.topHeightAt(5, 5)).toBeCloseTo(6, 6); // 2mm voxel × 3 层（0..6）
  });

  it("sampleMove 沿线段采样含端点", () => {
    const pts = sampleMove({ type: "LINEAR", x: 0, y: 0, z: 0 }, { type: "LINEAR", x: 10, y: 0, z: 0 }, 2);
    expect(pts[pts.length - 1]).toMatchObject({ x: 10, y: 0, z: 0 });
    expect(pts.length).toBeGreaterThan(2);
  });
});

describe("simulate（box 样本）", () => {
  const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
  const part = parseWorkerOutput(raw);
  const { cam } = planPart(part, buildFeatureGraph(part, "box").features);

  it("跑通并给出 PASS/量化指标", () => {
    const rep = simulate({ cam, partVolumeMm3: part.volume_mm3, frameStep: 4 });
    expect(rep.schema_version).toBe("1.0.0");
    expect(rep.initial_volume_mm3).toBeGreaterThan(part.volume_mm3);
    expect(rep.removed_volume_mm3).toBeGreaterThan(0);
    expect(rep.op_details.length).toBeGreaterThanOrEqual(2);
    expect(rep.frames.length).toBeGreaterThanOrEqual(2);
    expect(["PASS", "WARN", "FAIL"]).toContain(rep.status);
    expect(rep.removal_error_pct).toBeLessThan(30);
  });

  it("碰撞事件：构造贴毛坯 RAPID 必报", () => {
    // 直接构造一个低 z RAPID 的 CamIR 变体
    const cam2 = structuredClone(cam);
    const tp = cam2.toolpaths![0];
    tp.moves[0] = { type: "RAPID", x: 5, y: 5, z: -1 }; // 钻进毛坯内部
    const rep = simulate({ cam: cam2, partVolumeMm3: part.volume_mm3 });
    const coll = rep.events.filter((e) => e.kind === "COLLISION");
    expect(coll.length).toBeGreaterThan(0);
    expect(rep.status).toBe("FAIL");
  });
});
