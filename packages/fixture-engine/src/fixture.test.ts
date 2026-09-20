/** Fixture Planner v1 测试（P5-2） */
import { describe, expect, it } from "vitest";
import type { BBox, Feature } from "@ai-cam/domain-schemas";
import { planLocators, candidateFixtures, collisionCheck, planFixture, clampConflict } from "./fixture.js";

const box: BBox = { min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 50, z: 30 } };

describe("3-2-1 定位", () => {
  it("生成 6 个定位点（3 主 + 2 导向 + 1 止动），主基准为底面 -Z", () => {
    const p = planLocators(box);
    expect(p.constraint_count).toBe(6);
    expect(p.primary_face_normal).toBe("-Z");
    expect(p.locators.filter((l) => l.kind === "PRIMARY")).toHaveLength(3);
    expect(p.locators.filter((l) => l.kind === "SECONDARY")).toHaveLength(2);
    expect(p.locators.filter((l) => l.kind === "TERTIARY")).toHaveLength(1);
  });

  it("主基准三点位于底面 Z=0 且不共线（三角形分布）", () => {
    const p = planLocators(box);
    const primary = p.locators.filter((l) => l.kind === "PRIMARY");
    expect(primary.every((l) => l.z === 0)).toBe(true);
    const ys = new Set(primary.map((l) => l.y));
    expect(ys.size).toBeGreaterThan(1); // 至少两种 Y（非共线）
  });

  it("导向点位于 +X 侧面，止动点位于 -Y 端面", () => {
    const p = planLocators(box);
    expect(p.locators.filter((l) => l.kind === "SECONDARY").every((l) => l.x === 80)).toBe(true);
    expect(p.locators.filter((l) => l.kind === "TERTIARY")[0].y).toBe(0);
  });
});

describe("候选装夹", () => {
  it("X 夹持生成平口钳与软爪候选，接触带避开顶面", () => {
    const c = candidateFixtures(box, { soft_jaw: true });
    const vise = c.find((x) => x.type === "VISE");
    const jaw = c.find((x) => x.type === "SOFT_JAW");
    expect(vise).toBeDefined();
    expect(jaw).toBeDefined();
    expect(vise!.contact.z1).toBeLessThanOrEqual(30); // 不覆盖顶面
    expect(jaw!.body.z1).toBeGreaterThan(30); // 软爪高出顶面
  });

  it("Y 夹持生成 Y 向钳体", () => {
    const c = candidateFixtures(box, { clamp_axis: "Y" });
    expect(c[0].clamp_dir).toBe("+Y");
    expect(c[0].body.y0).toBeLessThan(0);
  });

  it("planFixture 返回推荐夹具", () => {
    const p = planFixture(box, { soft_jaw: true });
    expect(p.recommended_id).toBe("fx_softjaw_x");
    expect(p.locate.constraint_count).toBe(6);
  });
});

describe("碰撞检查", () => {
  it("刀路与夹具本体无重叠时通过", () => {
    const [fx] = candidateFixtures(box);
    const bounds: BBox[] = [{ min: { x: 10, y: 10, z: 10 }, max: { x: 70, y: 40, z: 20 } }];
    const r = collisionCheck([fx], bounds);
    expect(r.ok).toBe(true);
  });

  it("刀路进入夹具钳体时检出干涉", () => {
    const [fx] = candidateFixtures(box);
    const bounds: BBox[] = [{ min: { x: -30, y: 10, z: 10 }, max: { x: 10, y: 40, z: 20 } }];
    const r = collisionCheck([fx], bounds);
    expect(r.ok).toBe(false);
    expect(r.collisions[0].fixture_id).toBe(fx.id);
  });
});

describe("夹持冲突", () => {
  it("侧向可访问特征与夹持方向冲突被提示", () => {
    const [fx] = candidateFixtures(box);
    const feats: Feature[] = [
      { id: "f1", type: "POCKET", confidence: 0.9, source_face_ids: [], bbox: box, accessible_directions: ["+Z"], recognized_by: "ENGINE", recognizer_version: "test" },
      { id: "f2", type: "POCKET", confidence: 0.9, source_face_ids: [], bbox: box, accessible_directions: ["-X"], recognized_by: "ENGINE", recognizer_version: "test" },
    ];
    const c = clampConflict(feats, fx);
    expect(c.some((m) => m.startsWith("f2"))).toBe(true);
    expect(c.some((m) => m.startsWith("f1"))).toBe(false);
  });
});
