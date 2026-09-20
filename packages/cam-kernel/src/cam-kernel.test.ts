/** cam-kernel 单元测试：2D 几何 / 分层 / 覆盖 / 各刀路生成器 */
import { describe, expect, it } from "vitest";
import { concentricRects, horizontalLines, insetRect, splitLayers, zigzagChain, rect2 } from "./geometry2d.js";
import { faceCoverage, faceOp, pocketOp, profileOp, drillOp, adaptiveOp } from "./ops/index.js";
import { helixEntry, createMoveBuilder } from "./linking.js";

const R = rect2(0, 0, 100, 60);

describe("geometry2d", () => {
  it("insetRect 收缩正确", () => {
    const r = insetRect(R, 5)!;
    expect(r).toEqual({ x0: 5, y0: 5, x1: 95, y1: 55 });
    expect(insetRect(R, 60)).toBeNull();
  });

  it("行切步距 ≤ 2R 时覆盖率 ≥ 0.9", () => {
    expect(faceCoverage(R, 6, 5)).toBeGreaterThanOrEqual(0.9);
  });

  it("zigzag 折线连续且覆盖全部行", () => {
    const lines = horizontalLines(R, 10);
    expect(lines.length).toBe(7);
    const chain = zigzagChain(lines);
    expect(chain.length).toBeGreaterThanOrEqual(lines.length + 1);
  });

  it("splitLayers 从顶向下、不超过底面", () => {
    const layers = splitLayers(20, 5, 6);
    expect(layers[0]).toBe(20);
    expect(layers[layers.length - 1]).toBeGreaterThanOrEqual(5);
    for (const z of layers) expect(z).toBeGreaterThanOrEqual(5 - 1e-9);
  });

  it("同心环由外向内、间距 = stepover", () => {
    const rings = concentricRects(R, 5, 10);
    expect(rings.length).toBeGreaterThan(2);
    expect(rings[0].x0).toBe(0);
    expect(rings[1].x0).toBe(10);
    expect(rings[rings.length - 1].x1 - rings[rings.length - 1].x0).toBeGreaterThanOrEqual(10);
  });
});

describe("toolpath generators", () => {
  it("Face：行切覆盖 + 进刀在区域外 + 抬刀结束", () => {
    const moves = faceOp({ region: R, zCut: 19.95, stepover: 8, toolR: 5, feed: 1200, plungeFeed: 600, safeZ: 50 });
    expect(moves.length).toBeGreaterThanOrEqual(18);
    const feed = moves.filter((m) => m.type !== "RAPID");
    expect(feed.every((m) => m.feed_mm_min && m.feed_mm_min > 0)).toBe(true);
    expect(moves[0].type).toBe("RAPID");
    expect(moves[0].z).toBe(50);
    expect(moves[moves.length - 1].type).toBe("RETRACT");
    // 全部 z ≤ safeZ
    expect(Math.max(...moves.map((m) => m.z))).toBeLessThanOrEqual(50);
  });

  it("Pocket 闭腔：层切 + 螺旋进刀", () => {
    const moves = pocketOp({ region: rect2(10, 10, 50, 40), zTop: 20, zBottom: 5, stepdown: 6, stepover: 6, toolR: 3, feed: 1000, plungeFeed: 500, safeZ: 40 });
    expect(moves.length).toBeGreaterThan(10);
    expect(moves.some((m) => m.type === "LINEAR" && m.z < 6)).toBe(true); // 螺旋/环切切到底
  });

  it("Pocket 开槽（SLOT）：从开放侧进刀", () => {
    const moves = pocketOp({ region: rect2(0, 20, 100, 28), zTop: 15, zBottom: 10, stepdown: 5, stepover: 4, toolR: 4, feed: 1000, plungeFeed: 500, safeZ: 35, openSides: ["+X", "-X"] });
    expect(moves.length).toBeGreaterThanOrEqual(4);
    // 进刀 RAPID 在区域外（x < x0）
    const firstRapid = moves[0];
    expect(firstRapid.type).toBe("RAPID");
    expect(firstRapid.x).toBeLessThan(0);
  });

  it("Profile：多深度四圈 + 刀心偏移 toolR", () => {
    const moves = profileOp({ rect: R, zTop: 30, zBottom: 0, stepdown: 10, toolR: 4, feed: 1000, plungeFeed: 500, safeZ: 50, side: "OUTER" });
    // 层数 3 × 5 点 + 进退刀
    expect(moves.length).toBeGreaterThanOrEqual(3 * 5);
    const maxX = Math.max(...moves.filter((m) => m.type === "LINEAR").map((m) => m.x));
    expect(maxX).toBe(104); // 100 + toolR
  });

  it("Drill：点钻 + 钻孔；深径比>3 走啄钻", () => {
    const moves = drillOp({ holes: [{ cx: 20, cy: 20, depth: 15, through: true }], zTop: 15, toolR: 5, feed: 800, plungeFeed: 400, safeZ: 35, spotDepth: 1, peckStep: 10 });
    expect(moves.filter((m) => m.type === "PLUNGE").length).toBeGreaterThanOrEqual(2); // spot + drill
    expect(moves.some((m) => m.z <= 0)).toBe(true); // 过穿
  });

  it("Adaptive：层切 + 环切", () => {
    const moves = adaptiveOp({ region: rect2(10, 10, 70, 50), zTop: 25, zBottom: 5, stepdown: 8, stepover: 6, toolR: 4, feed: 1200, plungeFeed: 600, safeZ: 45 });
    expect(moves.length).toBeGreaterThan(10);
    expect(Math.max(...moves.map((m) => m.z))).toBeLessThanOrEqual(45);
  });

  it("helixEntry：螺旋微段 z 单调下降", () => {
    const b = createMoveBuilder();
    helixEntry(b, 30, 30, 20, 10, 5, 500, 2);
    const zs = b.moves.map((m) => m.z);
    for (let i = 1; i < zs.length; i++) expect(zs[i]).toBeLessThan(zs[i - 1]);
    expect(zs[zs.length - 1]).toBeCloseTo(10, 5);
  });
});
