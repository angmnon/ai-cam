/**
 * geometry_worker 输出的规范化零件模型契约（单位 mm）。
 * 与 cpp/geometry-core/src/main.cpp 的输出严格对应。
 */
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { z } from "zod";

export const Vec3Arr = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3Arr = z.infer<typeof Vec3Arr>;

export const BBoxArr = z.object({ min: Vec3Arr, max: Vec3Arr });
export type BBoxArr = z.infer<typeof BBoxArr>;

export const FaceEdgeInfo = z.object({
  type: z.enum(["LINE", "CIRCLE", "CURVE", "SEAM"]),
  length_mm: z.number(),
  radius_mm: z.number().optional(),
});
export type FaceEdgeInfo = z.infer<typeof FaceEdgeInfo>;

export const FaceInfo = z.object({
  id: z.number().int().positive(),
  type: z.enum(["PLANE", "CYLINDER", "CONE", "SPHERE", "TORUS", "OTHER"]),
  area_mm2: z.number(),
  bbox: BBoxArr,
  /** 平面/曲面朝外法向（BRep_Tool::Normal，按面朝向定向） */
  normal: Vec3Arr.optional(),
  /** 圆柱/圆锥轴方向 */
  axis: Vec3Arr.optional(),
  /** 面中心（BBox 中心投影点） */
  center: Vec3Arr,
  radius_mm: z.number().optional(),
  edge_count: z.number().int().nonnegative(),
  edges: z.array(FaceEdgeInfo),
});
export type FaceInfo = z.infer<typeof FaceInfo>;

export const EdgeInfo = z.object({
  id: z.number().int().positive(),
  type: z.enum(["LINE", "CIRCLE", "CURVE", "SEAM"]),
  length_mm: z.number(),
  radius_mm: z.number().optional(),
  /** 邻接面 id 列表（2 个） */
  face_ids: z.array(z.number().int()),
});
export type EdgeInfo = z.infer<typeof EdgeInfo>;

export const NormalizedPartModel = z.object({
  status: z.literal("ok"),
  file: z.string(),
  occt_version: z.string(),
  units: z.literal("mm"),
  healing_valid: z.boolean(),
  solid_count: z.number().int().nonnegative(),
  bbox_mm: BBoxArr,
  volume_mm3: z.number(),
  face_count: z.number().int().nonnegative(),
  faces: z.array(FaceInfo),
  edge_count: z.number().int().nonnegative(),
  edges: z.array(EdgeInfo),
});
export type NormalizedPartModel = z.infer<typeof NormalizedPartModel>;

export function parseWorkerOutput(raw: string): NormalizedPartModel {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new ApiError({
      code: ErrorCodes.CAD_PARSE_FAILED,
      message: "geometry worker output is not valid JSON",
      stage: "geometry",
      details: { cause: e instanceof Error ? e.message : String(e) },
    });
  }
  if (typeof json === "object" && json !== null && (json as { status?: string }).status === "error") {
    const message = (json as { message?: string }).message ?? raw;
    const healingFailed = /heal/i.test(message);
    throw new ApiError({
      code: healingFailed ? ErrorCodes.CAD_HEALING_FAILED : ErrorCodes.CAD_PARSE_FAILED,
      message: `geometry worker error: ${message}`,
      stage: "geometry",
    });
  }
  return NormalizedPartModel.parse(json);
}
