/**
 * MFG 制造特征（06_几何处理与制造特征识别详细设计）。
 * Feature Graph 节点类型；识别结果带 confidence 与证据面引用。
 */
import { z } from "zod";

export const FeatureTypes = [
  "PLANAR_FACE",
  "VERTICAL_WALL",
  "STEP",
  "POCKET",
  "OPEN_POCKET",
  "SLOT",
  "BOSS",
  "HOLE_THROUGH",
  "HOLE_BLIND",
  "COUNTERBORE",
  "COUNTERSINK",
  "OUTER_PROFILE",
  "INNER_PROFILE",
  "CHAMFER",
  "FILLET",
  "PLANAR_REGION",
  "FREEFORM_SURFACE",
  "STEEP_SURFACE",
  "SHALLOW_SURFACE",
] as const;
export type FeatureType = (typeof FeatureTypes)[number];

export const Vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Vec3 = z.infer<typeof Vec3>;

export const BBox = z.object({ min: Vec3, max: Vec3 });
export type BBox = z.infer<typeof BBox>;

export const Feature = z.object({
  id: z.string(),
  type: z.enum(FeatureTypes),
  /** 识别置信度 0..1（≥0.8 视为可靠） */
  confidence: z.number().min(0).max(1),
  /** 组成该特征的源拓扑面 id（证据，可追溯） */
  source_face_ids: z.array(z.string()).default([]),
  bbox: BBox,
  /** 可访问方向（±X/±Y/±Z） */
  accessible_directions: z.array(z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"])),
  /** 特征关键尺寸（mm），类型相关 */
  dimensions: z.record(z.string(), z.number()).optional(),
  /** 关联父特征（特征图边） */
  parent_feature_id: z.string().optional(),
  /** 识别器版本（可复现） */
  recognizer_version: z.string(),
  /** 若为 AI 辅助识别，记录来源 */
  recognized_by: z.enum(["ENGINE", "AI", "MANUAL"]).default("ENGINE"),
});
export type Feature = z.infer<typeof Feature>;

/** MFG Feature Graph（有向无环图 + 邻接边） */
export const FeatureGraph = z.object({
  part_id: z.string(),
  features: z.array(Feature),
  /** 特征间关系：containment / adjacency / accessibility */
  edges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        relation: z.enum(["CONTAINS", "ADJACENT", "ACCESSIBLE_VIA"]),
      }),
    )
    .default([]),
  recognizer_version: z.string(),
  created_at: z.string(),
});
export type FeatureGraph = z.infer<typeof FeatureGraph>;
