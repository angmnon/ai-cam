/** FeatureCandidate → MFG FeatureGraph（domain-schemas 契约） */
import type { FeatureGraph } from "@ai-cam/domain-schemas";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";

import { recognize, type FeatureCandidate } from "./recognize.js";
import { featureBoxToArr } from "./recognize.js";

export const RECOGNIZER_VERSION = "0.1.0";

export function buildFeatureGraph(
  part: NormalizedPartModel,
  partId: string,
  options: { created_at?: string } = {},
): FeatureGraph {
  const features = recognize(part);
  return {
    part_id: partId,
    features: features.map((f) => toGraphFeature(f)),
    edges: [],
    recognizer_version: RECOGNIZER_VERSION,
    created_at: options.created_at ?? new Date().toISOString(),
  };
}

export function toGraphFeature(f: FeatureCandidate) {
  const b = featureBoxToArr(f.bbox);
  return {
    id: f.id,
    type: f.type,
    confidence: f.confidence,
    source_face_ids: f.source_face_ids.map(String),
    bbox: { min: { x: b.min[0], y: b.min[1], z: b.min[2] }, max: { x: b.max[0], y: b.max[1], z: b.max[2] } },
    accessible_directions: f.accessible_directions,
    dimensions: f.dimensions,
    recognizer_version: RECOGNIZER_VERSION,
    recognized_by: "ENGINE" as const,
  };
}
