/** Indexed 4 轴管线测试（P5-1） */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Feature } from "@ai-cam/domain-schemas";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { validateCamIR } from "@ai-cam/cam-ir";
import { transformPoint, invertPoint, rotatedPlusZ, transformBBox } from "./transform.js";
import { assignFeaturesToSetups, rotateGuard } from "./assign.js";
import { planIndexed4Axis } from "./compose.js";

const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
const part = parseWorkerOutput(raw);

const baseFeature = (id: string, type: Feature["type"], dirs: Feature["accessible_directions"], bbox?: Feature["bbox"]): Feature => ({
  id,
  type,
  confidence: 0.95,
  source_face_ids: ["f0"],
  bbox: bbox ?? { min: { x: 10, y: 10, z: 0 }, max: { x: 30, y: 30, z: 20 } },
  accessible_directions: dirs,
  dimensions: { depth_mm: 20 },
  recognizer_version: "test",
  recognized_by: "ENGINE",
});

describe("坐标变换（transform）", () => {
  it("A 轴 90°：+Z→-Y，逆变换还原", () => {
    const p = transformPoint({ x: 0, y: 0, z: 1 }, "A", 90);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(-1, 9);
    expect(p.z).toBeCloseTo(0, 9);
    const back = invertPoint(p, "A", 90);
    expect(back.z).toBeCloseTo(1, 9);
  });

  it("A 轴旋转不改变 X 坐标", () => {
    const p = transformPoint({ x: 7, y: 3, z: 4 }, "A", 135);
    expect(p.x).toBeCloseTo(7, 9);
  });

  it("B 轴 90°：+Z→+X", () => {
    const p = transformPoint({ x: 0, y: 0, z: 1 }, "B", 90);
    expect(p.x).toBeCloseTo(1, 9);
    expect(p.z).toBeCloseTo(0, 9);
  });

  it("rotatedPlusZ 映射：A(0/90/180/270) → +Z/-Y/-Z/+Y；B(90/270) → +X/-X", () => {
    expect(rotatedPlusZ("A", 0)).toBe("+Z");
    expect(rotatedPlusZ("A", 90)).toBe("-Y");
    expect(rotatedPlusZ("A", 180)).toBe("-Z");
    expect(rotatedPlusZ("A", 270)).toBe("+Y");
    expect(rotatedPlusZ("B", 90)).toBe("+X");
    expect(rotatedPlusZ("B", 270)).toBe("-X");
  });

  it("BBox 变换后边界正确（A 90：高变深）", () => {
    const t = transformBBox({ min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 50, z: 30 } }, "A", 90);
    expect(t.max.x).toBeCloseTo(80, 6);
    expect(t.max.y).toBeCloseTo(0, 6);
    expect(t.max.z).toBeCloseTo(50, 6);
    expect(t.min.y).toBeCloseTo(-30, 6);
  });
});

describe("特征分配（assign）", () => {
  it("A 轴：+Y 侧特征 → 270°，+Z 特征 → 0°，双向孔 → 0/180 双角度", () => {
    const feats = [baseFeature("fY", "POCKET", ["+Y"]), baseFeature("fZ", "PLANAR_FACE", ["+Z"]), baseFeature("fT", "HOLE_THROUGH", ["+Z", "-Z"])];
    const { assignments, guard } = assignFeaturesToSetups(feats, "A", [0, 90, 180, 270]);
    expect(guard.ok).toBe(true);
    const by = Object.fromEntries(assignments.map((a) => [a.feature_id, a]));
    expect(by.fY.angle).toBe(270);
    expect(by.fZ.angle).toBe(0);
    expect(by.fT.angle).toBe(0);
    expect(by.fT.all_angles).toEqual([0, 180]);
  });

  it("B 轴：+X 侧特征 → 90°（A 轴无法覆盖侧向 X）", () => {
    const feats = [baseFeature("fX", "POCKET", ["+X"])];
    const a = assignFeaturesToSetups(feats, "A", [0, 90, 180, 270]);
    expect(a.guard.ok).toBe(false);
    expect(a.guard.violations[0].path).toBe("fX");
    const b = assignFeaturesToSetups(feats, "B", [0, 90, 180, 270]);
    expect(b.guard.ok).toBe(true);
    expect(b.assignments[0].angle).toBe(90);
  });

  it("rotateGuard：行程超限被检出", () => {
    const feats = [baseFeature("fBig", "POCKET", ["+Y"], { min: { x: 0, y: 0, z: 0 }, max: { x: 800, y: 50, z: 30 } })];
    const { assignments } = assignFeaturesToSetups(feats, "A", [0, 90, 180, 270]);
    const g = rotateGuard(feats, assignments, "A", [0, 90, 180, 270], { machineTravel: { x: 600, y: 500, z: 400 } });
    expect(g.ok).toBe(false);
    expect(g.violations.some((v) => v.path === "fBig")).toBe(true);
  });

  it("rotateGuard：未配置行程时 ok:true，travel 提示归入 infos（INFO 不阻塞）", () => {
    const feats = [baseFeature("fZ", "PLANAR_FACE", ["+Z"])];
    const { assignments } = assignFeaturesToSetups(feats, "A", [0, 90, 180, 270]);
    const g = rotateGuard(feats, assignments, "A", [0, 90, 180, 270]);
    expect(g.ok).toBe(true);
    expect(g.violations).toHaveLength(0);
    expect(g.infos.some((v) => v.path === "travel")).toBe(true);
  });

  it("rotateGuard：配置行程且未超限 → ok:true，无 violations/infos", () => {
    const feats = [baseFeature("fZ", "PLANAR_FACE", ["+Z"], { min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 50, z: 30 } })];
    const { assignments } = assignFeaturesToSetups(feats, "A", [0, 90, 180, 270]);
    const g = rotateGuard(feats, assignments, "A", [0, 90, 180, 270], { machineTravel: { x: 600, y: 500, z: 400 } });
    expect(g.ok).toBe(true);
    expect(g.violations).toHaveLength(0);
    expect(g.infos).toHaveLength(0);
  });

  it("assignFeaturesToSetups：方向字面量经类型收窄匹配（B 轴 +X → 90°，guard 带空 infos）", () => {
    const feats = [baseFeature("fX", "POCKET", ["+X"])];
    const res = assignFeaturesToSetups(feats, "B", [0, 90, 180, 270]);
    expect(res.guard.ok).toBe(true);
    expect(res.guard.infos).toHaveLength(0);
    expect(res.assignments[0].angle).toBe(90);
  });
});

describe("4 轴组装（compose）", () => {
  it("纯 +Z 特征集：全部归入 0° Setup，无 INDEX_ROTATE，CamIR 校验通过", () => {
    const feats = [baseFeature("fA", "PLANAR_FACE", ["+Z"]), baseFeature("fB", "POCKET", ["+Z"]), baseFeature("fC", "HOLE_BLIND", ["+Z"])];
    const res = planIndexed4Axis(part, feats, {});
    expect(res.per_setup[0].feature_count).toBe(3);
    expect(res.index_ops.length).toBe(0);
    expect(res.setups.length).toBe(4);
    expect(res.setups[0].rotation).toBeUndefined();
    expect(res.setups[1].rotation).toEqual({ axis: "A", angle: 90 });
    expect(validateCamIR(res.cam).ok).toBe(true);
  });

  it("含 +Y 侧向特征：进入 270° Setup + INDEX_ROTATE 操作", () => {
    const feats = [...buildFeatureGraphFromBox(), baseFeature("fSideY", "POCKET", ["+Y"], { min: { x: 0, y: 45, z: 5 }, max: { x: 20, y: 50, z: 25 } })];
    const res = planIndexed4Axis(part, feats, {});
    const idx = res.assignments.find((a) => a.feature_id === "fSideY");
    expect(idx?.angle).toBe(270);
    expect(res.per_setup[270].feature_count).toBe(1);
    expect(res.index_ops.length).toBeGreaterThan(0);
    expect(res.index_ops[0].type).toBe("INDEX_ROTATE");
    expect(res.cam.setups.find((s) => s.rotation?.angle === 270)?.wcs).toBe("G55");
    expect(validateCamIR(res.cam).ok).toBe(true);
  });
});

function buildFeatureGraphFromBox(): Feature[] {
  return buildFeatureGraph(part, "box").features;
}
