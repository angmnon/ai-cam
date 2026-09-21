/**
 * 稀疏体素网格（P3-1）：确定性材料去除的基础数据结构。
 * - 与全局坐标系对齐的 AABB 体素盒；voxel 尺寸默认 2mm（可配置）
 * - 稀疏存储（Map<string, true>），支持 BOX 毛坯初始化、圆柱扫掠扣除、统计与快照
 */
import type { CamIR, ToolpathMove } from "@ai-cam/cam-ir";

export interface VoxelOptions {
  /** 体素边长（mm），默认 2 */
  voxelSize?: number;
}

export interface VoxelGridSpec {
  minX: number;
  minY: number;
  minZ: number;
  nx: number;
  ny: number;
  nz: number;
  voxel: number;
}

export interface VoxelStats {
  filled: number;
  volume_mm3: number;
  /** 沿 z 的每列最高填充体素高度（用于残料顶面检查） */
  topHeights: Map<string, number>;
}

const KEY = (ix: number, iy: number, iz: number) => `${ix}|${iy}|${iz}`;

export class VoxelGrid {
  readonly spec: VoxelGridSpec;
  private filled = new Map<string, boolean>();
  /** 每列 (i,j) 当前最高填充体素的 k 索引（-1=空列）；fillBox/cutCylinder 增量维护，避免 stats() 全表 split("|") */
  private topK = new Map<string, number>();
  /** stats() 结果缓存；任何修改（fillBox/cutCylinder）后置 null 失效，命中时 O(1) 返回 */
  private statsCache: VoxelStats | null = null;

  constructor(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, opts: VoxelOptions = {}) {
    const v = opts.voxelSize ?? 2;
    this.spec = {
      minX,
      minY,
      minZ,
      nx: Math.max(1, Math.ceil((maxX - minX) / v)),
      ny: Math.max(1, Math.ceil((maxY - minY) / v)),
      nz: Math.max(1, Math.ceil((maxZ - minZ) / v)),
      voxel: v,
    };
  }

  get voxel(): number {
    return this.spec.voxel;
  }

  /** 填充矩形盒 [x0,y0,z0]..[x1,y1,z1] 内的所有体素 */
  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const s = this.spec;
    const i0 = this.clampI(Math.floor((x0 - s.minX) / s.voxel));
    const i1 = this.clampI(Math.ceil((x1 - s.minX) / s.voxel));
    const j0 = this.clampJ(Math.floor((y0 - s.minY) / s.voxel));
    const j1 = this.clampJ(Math.ceil((y1 - s.minY) / s.voxel));
    const k0 = this.clampK(Math.floor((z0 - s.minZ) / s.voxel));
    const k1 = this.clampK(Math.ceil((z1 - s.minZ) / s.voxel));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          this.filled.set(KEY(i, j, k), true);
        }
        // k 单调递增，本列新填到的最高 k = k1；与既有列顶取 max
        const col = KEY(i, j, 0);
        const prev = this.topK.get(col) ?? -1;
        if (k1 > prev) this.topK.set(col, k1);
      }
    }
    this.statsCache = null;
  }

  /** 扣除刀具圆柱扫掠：半径 R，z ∈ [zBot, zTop]（zBot=刀底切削深度），圆心 (cx, cy) */
  cutCylinder(cx: number, cy: number, zBot: number, zTop: number, radius: number): void {
    const s = this.spec;
    if (zTop <= s.minZ || zBot >= s.minZ + s.nz * s.voxel) return; // z 无交集
    const R = radius + s.voxel * 0.5; // 保守扩张半个体素，避免间隙
    const i0 = this.clampI(Math.floor((cx - R - s.minX) / s.voxel));
    const i1 = this.clampI(Math.ceil((cx + R - s.minX) / s.voxel));
    const j0 = this.clampJ(Math.floor((cy - R - s.minY) / s.voxel));
    const j1 = this.clampJ(Math.ceil((cy + R - s.minY) / s.voxel));
    const k0 = Math.max(0, Math.floor((zBot - s.minZ) / s.voxel));
    const k1 = Math.min(s.nz - 1, Math.ceil((zTop - s.minZ) / s.voxel));
    const r2 = R * R;
    const touched: Array<[number, number]> = [];
    for (let i = i0; i <= i1; i++) {
      const wx = s.minX + (i + 0.5) * s.voxel;
      const dx = wx - cx;
      for (let j = j0; j <= j1; j++) {
        const wy = s.minY + (j + 0.5) * s.voxel;
        const dy = wy - cy;
        if (dx * dx + dy * dy > r2) continue;
        let removed = false;
        for (let k = k0; k <= k1; k++) {
          if (this.filled.delete(KEY(i, j, k))) removed = true;
        }
        if (removed) touched.push([i, j]);
      }
    }
    // 被删列可能列顶被切穿：逐列向下重找新顶（仅触达列，O(nz)），不全表扫描
    for (const [i, j] of touched) this.recomputeColumnTop(i, j);
    this.statsCache = null;
  }

  /** 删除后重算单列 (i,j) 的最高填充 k：从 nz-1 向下找首个仍填充体素；空列移除列记录 */
  private recomputeColumnTop(i: number, j: number): void {
    const s = this.spec;
    const col = KEY(i, j, 0);
    let k = s.nz - 1;
    while (k >= 0 && !this.filled.has(KEY(i, j, k))) k--;
    if (k < 0) this.topK.delete(col);
    else this.topK.set(col, k);
  }

  /** 点是否落在某柱状区域内（供碰撞检测：刀具圆柱 vs 剩余毛坯） */
  anyInCylinder(cx: number, cy: number, zBot: number, zTop: number, radius: number): boolean {
    const s = this.spec;
    if (zTop <= s.minZ || zBot >= s.minZ + s.nz * s.voxel) return false; // z 无交集
    const R = radius;
    const i0 = this.clampI(Math.floor((cx - R - s.minX) / s.voxel));
    const i1 = this.clampI(Math.ceil((cx + R - s.minX) / s.voxel));
    const j0 = this.clampJ(Math.floor((cy - R - s.minY) / s.voxel));
    const j1 = this.clampJ(Math.ceil((cy + R - s.minY) / s.voxel));
    const k0 = Math.max(0, Math.floor((zBot - s.minZ) / s.voxel));
    const k1 = Math.min(s.nz - 1, Math.ceil((zTop - s.minZ) / s.voxel));
    const r2 = R * R;
    for (let i = i0; i <= i1; i++) {
      const wx = s.minX + (i + 0.5) * s.voxel;
      const dx = wx - cx;
      for (let j = j0; j <= j1; j++) {
        const wy = s.minY + (j + 0.5) * s.voxel;
        const dy = wy - cy;
        if (dx * dx + dy * dy > r2) continue;
        for (let k = k0; k <= k1; k++) {
          if (this.filled.has(KEY(i, j, k))) return true;
        }
      }
    }
    return false;
  }

  /** Holder 圆柱（刀柄，直径 > 刀具直径）与剩余毛坯体素求交：圆心(cx,cy)，z ∈ [zBot,zTop]，半径 holderRadius。 */
  anyHolderOverlap(cx: number, cy: number, zBot: number, zTop: number, holderRadius: number): boolean {
    return this.anyInCylinder(cx, cy, zBot, zTop, holderRadius);
  }

  /**
   * 统计填充体素。O(1)：filled.size 直接取；topHeights 由增量维护的 topK 映射生成并缓存，
   * 命中缓存时零遍历；任何 fillBox/cutCylinder 均会使缓存失效。
   */
  stats(): VoxelStats {
    if (this.statsCache) return this.statsCache;
    const s = this.spec;
    const topHeights = new Map<string, number>();
    for (const [col, k] of this.topK) {
      topHeights.set(col, s.minZ + (k + 1) * s.voxel);
    }
    this.statsCache = {
      filled: this.filled.size,
      volume_mm3: this.filled.size * s.voxel * s.voxel * s.voxel,
      topHeights,
    };
    return this.statsCache;
  }

  /** 某一列（XY 格）的剩余最高材料面（无材料返回 -Infinity） */
  topHeightAt(x: number, y: number): number {
    const s = this.spec;
    const i = this.clampI(Math.floor((x - s.minX) / s.voxel));
    const j = this.clampJ(Math.floor((y - s.minY) / s.voxel));
    let h = -Infinity;
    for (let k = 0; k < s.nz; k++) {
      if (this.filled.has(KEY(i, j, k))) h = s.minZ + (k + 1) * s.voxel;
    }
    return h;
  }

  /** 导出降采样快照（供前端播放；voxel 倍率下采样，返回密度场） */
  snapshot(step = 2): Array<{ x: number; y: number; z: number; solid: boolean }> {
    const s = this.spec;
    const out: Array<{ x: number; y: number; z: number; solid: boolean }> = [];
    const stepI = Math.max(1, Math.floor(step));
    for (let i = 0; i < s.nx; i += stepI) {
      for (let j = 0; j < s.ny; j += stepI) {
        for (let k = 0; k < s.nz; k += stepI) {
          out.push({
            x: s.minX + (i + 0.5) * s.voxel,
            y: s.minY + (j + 0.5) * s.voxel,
            z: s.minZ + (k + 0.5) * s.voxel,
            solid: this.filled.has(KEY(i, j, k)),
          });
        }
      }
    }
    return out;
  }

  private clampI(v: number): number {
    return Math.max(0, Math.min(this.spec.nx - 1, v));
  }
  private clampJ(v: number): number {
    return Math.max(0, Math.min(this.spec.ny - 1, v));
  }
  private clampK(v: number): number {
    return Math.max(0, Math.min(this.spec.nz - 1, v));
  }
}

/** 由 CAM IR stock 初始化毛坯体素（BOX 毛坯） */
export function voxelizeStock(cam: CamIR, opts: VoxelOptions = {}): VoxelGrid {
  const stock = cam.stock;
  const d = stock.dimensions ?? { x: 100, y: 100, z: 40 };
  const o = stock.origin ?? { x: -50, y: -50, z: 0 };
  const grid = new VoxelGrid(o.x, o.y, o.z, o.x + (d.x ?? 100), o.y + (d.y ?? 100), o.z + (d.z ?? 40), opts);
  grid.fillBox(o.x, o.y, o.z, o.x + (d.x ?? 100), o.y + (d.y ?? 100), o.z + (d.z ?? 40));
  return grid;
}

/**
 * 线段采样：从 prev 目标点到 cur 目标点（步长 ≈ voxel/2），
 * 采样点运动类型 = cur.type（到达该点的方式）；不含 prev 点，含 cur 点。
 */
export function sampleMove(prev: ToolpathMove, cur: ToolpathMove, voxel: number): ToolpathMove[] {
  const len = Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z);
  const steps = Math.max(1, Math.ceil(len / Math.max(0.5, voxel / 2)));
  const pts: ToolpathMove[] = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    pts.push({ type: cur.type, x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t, z: prev.z + (cur.z - prev.z) * t, feed_mm_min: cur.feed_mm_min });
  }
  pts.push(cur);
  return pts;
}
