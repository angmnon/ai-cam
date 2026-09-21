/** stock-sim 单元测试：体素 / 材料去除 / 碰撞 / Gouge / 残料阈值 */
import { describe, expect, it } from "vitest";
import { VoxelGrid, sampleMove } from "./voxel.js";
import { simulate } from "./simulation.js";
import { planPart } from "@ai-cam/cam-kernel";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import type { CamIR } from "@ai-cam/cam-ir";
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

  it("stats() 数值与手动统计一致（fillBox + cutCylinder 后 filled/volume/topHeights + 缓存命中）", () => {
    const voxel = 2;
    const g = new VoxelGrid(0, 0, 0, 20, 20, 10, { voxelSize: voxel });
    g.fillBox(0, 0, 0, 20, 20, 10);
    // 切中心圆柱：半径 4，z 从底到顶（覆盖全部 k）
    g.cutCylinder(10, 10, 0, 10, 4);

    // 独立复算：枚举所有 (i,j,k)，按 cutCylinder 同一几何规则判定是否仍填充
    const nx = 10, ny = 10, nz = 5;
    const R = 4 + voxel * 0.5; // 与 cutCylinder 内部扩张一致
    const r2 = R * R;
    let manualFilled = 0;
    const manualTop = new Map<string, number>();
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const wx = (i + 0.5) * voxel;
        const wy = (j + 0.5) * voxel;
        const inCyl = (wx - 10) ** 2 + (wy - 10) ** 2 <= r2;
        for (let k = 0; k < nz; k++) {
          if (inCyl) continue; // 整列被切穿
          manualFilled++;
          const col = `${i}|${j}|0`;
          const z = (k + 1) * voxel;
          const prev = manualTop.get(col) ?? -Infinity;
          if (z > prev) manualTop.set(col, z);
        }
      }
    }

    const s = g.stats();
    expect(s.filled).toBe(manualFilled);
    expect(s.volume_mm3).toBeCloseTo(manualFilled * voxel * voxel * voxel, 1);
    expect(s.topHeights.size).toBe(manualTop.size);
    for (const [col, z] of manualTop) {
      expect(s.topHeights.get(col)).toBe(z);
    }
    // 缓存命中：未再修改时再次 stats() 返回同一对象引用（O(1)）
    expect(g.stats()).toBe(s);
  });
});

const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
const part = parseWorkerOutput(raw);
const { cam } = planPart(part, buildFeatureGraph(part, "box").features);

describe("simulate（box 样本）", () => {
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

  it("P1-03 RAPID 在毛坯上方 5mm 低空掠过必报", () => {
    // 刀尖在毛坯顶上方 5mm（高于材料、未没入），旧仅查上方圆柱会漏检；
    // 新逻辑查刀尖下方 2R 悬伸带与剩余毛坯相交 → 必报碰撞。
    const cam2 = structuredClone(cam);
    const tp = cam2.toolpaths![0];
    const stockTop = (cam2.stock.origin!.z ?? 0) + (cam2.stock.dimensions!.z ?? 0);
    const ri = tp.moves.findIndex((m) => m.type === "RAPID");
    expect(ri).toBeGreaterThanOrEqual(0);
    const r0 = tp.moves[ri];
    tp.moves[ri] = { type: "RAPID", x: r0.x, y: r0.y, z: stockTop + 5 };
    const rep = simulate({ cam: cam2, partVolumeMm3: part.volume_mm3 });
    const coll = rep.events.filter((e) => e.kind === "COLLISION");
    expect(coll.length).toBeGreaterThan(0);
    expect(rep.status).toBe("FAIL");
  });

  it("P1-04 FACE 底平面低于特征底必报 gouge", () => {
    // FACE 面铣设计面 = 首个切削移动 z；追加一个远低于该面的直线切削 → gouge。
    const cam2 = structuredClone(cam);
    const tp = cam2.toolpaths![0];
    const firstCut = tp.moves.find((m) => m.type !== "RAPID" && m.type !== "RETRACT")!;
    expect(cam2.operations[0].type).toBe("FACE");
    const last = tp.moves[tp.moves.length - 1];
    tp.moves.push({ type: "LINEAR", x: last.x, y: last.y, z: firstCut.z - 10, feed_mm_min: 500 });
    const rep = simulate({ cam: cam2, partVolumeMm3: part.volume_mm3 });
    const gouge = rep.events.filter((e) => e.kind === "GOUGE");
    expect(gouge.length).toBeGreaterThan(0);
    expect(rep.status).toBe("FAIL");
  });
});

describe("P2-17 多层 FACE 顶面残料误判", () => {
  /**
   * 构造单一 FACE op：毛坯 z∈[0,10]。
   * 第一层（z1=8）全行面铣覆盖整个 XY；第二层（z2=4<z1）仅下探局部子区。
   * 残料检查应按首个切削层 zTop=z1=8 比较：
   *  - 仅第一层覆盖的区域 h≈8 → 残料≈0；
   *  - 第二层下探区域 h≈4 < z1 → 差值为负被钳为 0。
   * 旧实现用全 op 最深 minZ=z2=4 当期望顶面，会把仅第一层区域判成 h-z2=4mm 残料（误报）。
   */
  function buildMultiLayerFaceCam(z1: number, z2: number): CamIR {
    const moves: Array<{ type: NonNullable<CamIR["toolpaths"]>[number]["moves"][number]["type"]; x: number; y: number; z: number; feed_mm_min?: number }> = [];
    const rapid = (x: number, y: number) => moves.push({ type: "RAPID", x, y, z: 12 });
    const plunge = (x: number, y: number, z: number) => moves.push({ type: "PLUNGE", x, y, z, feed_mm_min: 200 });
    const linear = (x: number, y: number, z: number) => moves.push({ type: "LINEAR", x, y, z, feed_mm_min: 500 });
    const retract = (x: number, y: number) => moves.push({ type: "RETRACT", x, y, z: 12 });

    // 第一层 z1：三行满幅面铣，覆盖全 XY
    for (const y of [15, 30, 45]) {
      rapid(5, y);
      plunge(5, y, z1);
      linear(55, y, z1);
      retract(55, y);
    }
    // 第二层 z2<z1：仅局部子区（x∈[20,40], y=30）下探
    rapid(20, 30);
    plunge(20, 30, z2);
    linear(40, 30, z2);

    return {
      schema_version: "1.0.0",
      ir_id: "ir_p2_17",
      job_id: "job_p2_17",
      part_id: "part_p2_17",
      units: { length: "mm", angle: "deg", speed: "rpm", feed: "mm/min" },
      machine: { machine_id: "mch_vmc850", controller_id: "siemens_828d", axis_config: "3AXIS", travel: { x: 200, y: 200, z: 200 } },
      material: { material_id: "mat_al6061" },
      stock: { id: "stk_p2_17", kind: "BOX", dimensions: { x: 60, y: 60, z: 10 }, origin: { x: 0, y: 0, z: 0 } },
      setups: [{ id: "su1", wcs: "G54", origin: { x: 0, y: 0, z: 0 } }],
      tools: [{ tool_id: "tool_em_10" }],
      operations: [
        {
          id: "op_face1",
          op_index: 1,
          name: "FACE 多层",
          type: "FACE",
          setup_id: "su1",
          feature_ids: ["feat_face1"],
          depends_on: [],
          tool: { tool_id: "tool_em_10" },
          parameters: { spindle_speed_rpm: 3000, feed_mm_min: 500, coolant: "FLOOD", source: "ENGINE" },
          safe_z_mm: 12,
        },
      ],
      toolpaths: [
        { operation_id: "op_face1", toolpath_id: "tp_face1", engine_version: "test", move_count: moves.length, moves: moves as NonNullable<CamIR["toolpaths"]>[number]["moves"] },
      ],
    };
  }

  it("P2-17 多层 FACE：两层均残料≈0，不误报残料", () => {
    const z1 = 8;
    const z2 = 4;
    const cam = buildMultiLayerFaceCam(z1, z2);
    const rep = simulate({ cam, partVolumeMm3: 0, voxel: { voxelSize: 2 } });

    const face = rep.key_surfaces.find((k) => k.surface.includes("顶面"));
    expect(face).toBeDefined();
    // 期望顶面 = 首个切削层 z1=8：仅第一层区域 h≈8 → 残料≈0；下探层 h≈4 → 负差值钳 0。
    // 旧实现按最深 z2=4 比较会得 h-z2=4mm 残料（>1 voxel）→ 此处断言旧 bug 不复现。
    expect(face!.residual_mm).toBeGreaterThanOrEqual(0);
    expect(face!.residual_mm).toBeLessThanOrEqual(rep.voxel_size_mm);
    expect(face!.verdict).toBe("PASS");

    // 不得产生残料误报事件（深度下探触发的 gouge 属 P1-04 另一检测轴，不在本用例范围）
    const residualEvents = rep.events.filter((e) => e.kind === "RESIDUAL_WARN" || e.kind === "RESIDUAL_FAIL");
    expect(residualEvents).toEqual([]);
  });
});

describe("P2-18 stock 兜底显式化 / 刀具缺失 ERROR", () => {
  it("stock dimensions/origin 缺失 → 显式 WARN 事件 + metadata.stock_fallback=true", () => {
    const cam2 = structuredClone(cam);
    delete (cam2.stock as Record<string, unknown>).dimensions;
    delete (cam2.stock as Record<string, unknown>).origin;
    const rep = simulate({ cam: cam2, partVolumeMm3: part.volume_mm3 });
    const warn = rep.events.filter((e) => e.kind === "STOCK_FALLBACK" && e.severity === "WARN");
    expect(warn.length).toBeGreaterThan(0);
    expect(rep.metadata.stock_fallback).toBe(true);
  });

  it("stock 字段齐全 → 无 STOCK_FALLBACK，metadata.stock_fallback=false", () => {
    const rep = simulate({ cam, partVolumeMm3: part.volume_mm3 });
    expect(rep.events.some((e) => e.kind === "STOCK_FALLBACK")).toBe(false);
    expect(rep.metadata.stock_fallback).toBe(false);
  });

  it("刀具缺失（不在种子库）→ CONFIG_ERROR（severity ERROR），状态 FAIL", () => {
    const cam2 = structuredClone(cam);
    for (const op of cam2.operations) op.tool.tool_id = "tool_ghost_999";
    const rep = simulate({ cam: cam2, partVolumeMm3: part.volume_mm3 });
    const err = rep.events.filter((e) => e.kind === "CONFIG_ERROR" && e.severity === "ERROR");
    expect(err.length).toBeGreaterThan(0);
    // 不再伪装成 COLLISION 事件
    expect(rep.events.filter((e) => e.kind === "COLLISION" && e.message.includes("种子刀具库")).length).toBe(0);
    expect(rep.status).toBe("FAIL");
  });
});

describe("P2-19 球头体积球冠修正", () => {
  /**
   * 构造单一 POCKET op，BALL 刀 tool_ball_6（diameter=6 → R=3, corner_radius=3）：
   * RAPID 上方 → PLUNGE 到顶面 z=10 → PLUNGE 下探到 z=7（h=3）→ LINEAR 水平扫掠 Lxy=40 → RETRACT。
   * 体素网格仍做圆柱扫掠碰撞判定；仅 removed_volume 估算走球冠公式。
   */
  function buildBallCam(): CamIR {
    const moves: Array<{ type: NonNullable<CamIR["toolpaths"]>[number]["moves"][number]["type"]; x: number; y: number; z: number; feed_mm_min?: number }> = [];
    const rapid = (x: number, y: number) => moves.push({ type: "RAPID", x, y, z: 12 });
    const plunge = (x: number, y: number, z: number) => moves.push({ type: "PLUNGE", x, y, z, feed_mm_min: 200 });
    const linear = (x: number, y: number, z: number) => moves.push({ type: "LINEAR", x, y, z, feed_mm_min: 500 });
    const retract = (x: number, y: number) => moves.push({ type: "RETRACT", x, y, z: 12 });

    rapid(10, 30);
    plunge(10, 30, 10); // 到毛坯顶面（首个切削 move，prev=null 不计段）
    plunge(10, 30, 7); // 下探 h=3（球冠段）
    linear(50, 30, 7); // 水平扫掠 Lxy=40
    retract(50, 30);

    return {
      schema_version: "1.0.0",
      ir_id: "ir_p2_19",
      job_id: "job_p2_19",
      part_id: "part_p2_19",
      units: { length: "mm", angle: "deg", speed: "rpm", feed: "mm/min" },
      machine: { machine_id: "mch_vmc850", controller_id: "siemens_828d", axis_config: "3AXIS", travel: { x: 200, y: 200, z: 200 } },
      material: { material_id: "mat_al6061" },
      stock: { id: "stk_p2_19", kind: "BOX", dimensions: { x: 60, y: 60, z: 10 }, origin: { x: 0, y: 0, z: 0 } },
      setups: [{ id: "su1", wcs: "G54", origin: { x: 0, y: 0, z: 0 } }],
      tools: [{ tool_id: "tool_ball_6" }],
      operations: [
        {
          id: "op_ball1",
          op_index: 1,
          name: "BALL 球头",
          type: "POCKET",
          setup_id: "su1",
          feature_ids: ["feat_ball1"],
          tool: { tool_id: "tool_ball_6" },
          parameters: { spindle_speed_rpm: 3000, feed_mm_min: 500, coolant: "FLOOD", source: "ENGINE" },
          depends_on: [],
          safe_z_mm: 12,
        },
      ],
      toolpaths: [
        { operation_id: "op_ball1", toolpath_id: "tp_ball1", engine_version: "test", move_count: moves.length, moves: moves as NonNullable<CamIR["toolpaths"]>[number]["moves"] },
      ],
    };
  }

  it("BALL 刀 removed_volume 用球冠公式（而非圆柱近似）", () => {
    const cam = buildBallCam();
    const rep = simulate({ cam, partVolumeMm3: 0, voxel: { voxelSize: 2 } });
    expect(rep.op_details.length).toBe(1);
    const op = rep.op_details[0];
    expect(op.tool_id).toBe("tool_ball_6");

    // tool_ball_6: diameter=6 → R=3, corner_radius=3 → rCap=3
    // 水平段 Lxy=40：π·R²·Lxy = π·9·40 = 360π
    // 下探 h=3：球冠 V = π·h²·(3R-h)/3 = π·9·(9-3)/3 = 18π
    const R = 3;
    const Lxy = 40;
    const h = 3;
    const expected = Math.PI * R * R * Lxy + (Math.PI * h * h / 3) * (3 * R - h);
    expect(op.removed_volume_mm3).toBeCloseTo(expected, 1);

    // 若用圆柱近似下探（π·R²·h = 27π），总量为 387π；球冠仅 378π → 明显更小
    const naiveCylinder = Math.PI * R * R * Lxy + Math.PI * R * R * h;
    expect(op.removed_volume_mm3).toBeLessThan(naiveCylinder - 1);

    expect(rep.estimate_method).toBe("spherical_cap");
  });
});
