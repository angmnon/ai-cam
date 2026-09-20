/** 历史工艺检索测试（P5-5） */
import { describe, expect, it } from "vitest";
import type { Feature } from "@ai-cam/domain-schemas";
import { buildSignature, ProcessIndex, signatureDistance } from "./retrieval.js";

const feat = (id: string, type: Feature["type"], depth: number, w: number, h = 20): Feature => ({
  id,
  type,
  confidence: 0.95,
  source_face_ids: [],
  bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: w, y: Math.max(1, w - 2), z: h } },
  accessible_directions: ["+Z"],
  dimensions: { depth_mm: depth },
  recognized_by: "ENGINE",
  recognizer_version: "test",
});

describe("Feature Signature", () => {
  it("相同特征序列 → 相同 canonical", () => {
    const a = buildSignature([feat("a", "POCKET", 6, 20), feat("b", "HOLE_BLIND", 8, 5)]);
    const b = buildSignature([feat("x", "HOLE_BLIND", 8, 5), feat("y", "POCKET", 6, 20)]);
    expect(a.canonical).toBe(b.canonical);
  });

  it("尺寸分桶：不同尺寸但同桶 → 距离为 1（完全匹配）", () => {
    const a = buildSignature([feat("a", "POCKET", 6, 20)]);
    const b = buildSignature([feat("b", "POCKET", 5, 24)]); // 同桶（8-16 深 / 16-32 宽）
    const { score } = signatureDistance(a, b);
    expect(score).toBeCloseTo(1, 6);
  });

  it("类型差异降低分数", () => {
    const a = buildSignature([feat("a", "POCKET", 6, 20)]);
    const b = buildSignature([feat("b", "HOLE_BLIND", 6, 20)]);
    const { score } = signatureDistance(a, b);
    expect(score).toBe(0); // 类型集合无交集 → 0
  });
});

describe("ProcessIndex 检索", () => {
  it("相似零件返回历史工艺，并带可解释原因", () => {
    const idx = new ProcessIndex(0.5);
    idx.add({ job_id: "j1", part_name: "支架A", process_summary: "面铣+口袋+钻孔", operations_count: 6 }, [feat("a", "POCKET", 6, 20), feat("b", "HOLE_BLIND", 8, 5)]);
    idx.add({ job_id: "j2", part_name: "轴套B", process_summary: "外轮廓+钻孔", operations_count: 4 }, [feat("c", "BOSS", 6, 20)]);
    expect(idx.size()).toBe(2);
    const hits = idx.search([feat("x", "POCKET", 6, 20), feat("y", "HOLE_BLIND", 8, 5)], 3);
    expect(hits[0].job.job_id).toBe("j1");
    expect(hits[0].score).toBeGreaterThan(0.9);
    expect(hits[0].reasons.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].reasons[0]).toContain("Jaccard");
  });

  it("低于阈值的弱相似不返回", () => {
    const idx = new ProcessIndex(0.9);
    idx.add({ job_id: "j1", part_name: "件A", process_summary: "s", operations_count: 2 }, [feat("a", "POCKET", 6, 20)]);
    const hits = idx.search([feat("x", "BOSS", 6, 20)], 3);
    expect(hits).toHaveLength(0);
  });
});
