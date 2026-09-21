/** 历史工艺检索测试（P5-5） */
import { describe, expect, it } from "vitest";
import type { Feature } from "@ai-cam/domain-schemas";
import { buildSignature, ProcessIndex, signatureDistance, bucketOf } from "./retrieval.js";

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
    idx.add({ job_id: "j1", orgId: "orgA", part_name: "支架A", process_summary: "面铣+口袋+钻孔", operations_count: 6 }, [feat("a", "POCKET", 6, 20), feat("b", "HOLE_BLIND", 8, 5)], "orgA");
    idx.add({ job_id: "j2", orgId: "orgA", part_name: "轴套B", process_summary: "外轮廓+钻孔", operations_count: 4 }, [feat("c", "BOSS", 6, 20)], "orgA");
    expect(idx.size()).toBe(2);
    const hits = idx.search([feat("x", "POCKET", 6, 20), feat("y", "HOLE_BLIND", 8, 5)], "orgA", 3);
    expect(hits[0].job.job_id).toBe("j1");
    expect(hits[0].score).toBeGreaterThan(0.9);
    expect(hits[0].reasons.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].reasons[0]).toContain("Jaccard");
  });

  it("低于阈值的弱相似不返回", () => {
    const idx = new ProcessIndex(0.9);
    idx.add({ job_id: "j1", orgId: "orgA", part_name: "件A", process_summary: "s", operations_count: 2 }, [feat("a", "POCKET", 6, 20)], "orgA");
    const hits = idx.search([feat("x", "BOSS", 6, 20)], "orgA", 3);
    expect(hits).toHaveLength(0);
  });

  it("P1-16 租户隔离：orgA 只命中本租户，绝不跨到 orgB", () => {
    const idx = new ProcessIndex(0.5);
    // 两租户各放一件特征几乎相同的历史工艺（相似度本应很高）
    idx.add({ job_id: "jA1", orgId: "orgA", part_name: "A件", process_summary: "A工艺", operations_count: 2 }, [feat("a", "POCKET", 6, 20)], "orgA");
    idx.add({ job_id: "jB1", orgId: "orgB", part_name: "B件", process_summary: "B工艺", operations_count: 2 }, [feat("b", "POCKET", 6, 20)], "orgB");

    const idsOf = (hits: ReturnType<ProcessIndex["search"]>) => hits.map((h) => h.job.job_id);

    const hitsA = idsOf(idx.search([feat("q", "POCKET", 6, 20)], "orgA", 5));
    expect(hitsA).toContain("jA1");
    expect(hitsA).not.toContain("jB1");

    const hitsB = idsOf(idx.search([feat("q", "POCKET", 6, 20)], "orgB", 5));
    expect(hitsB).toContain("jB1");
    expect(hitsB).not.toContain("jA1");

    // 未知/空租户检索不到任何历史
    expect(idx.search([feat("q", "POCKET", 6, 20)], "orgX", 5)).toHaveLength(0);
  });
});

describe("对数分桶 / 哨兵桶（P3-27）", () => {
  it("超大值之间不再共用同一哨兵桶", () => {
    // 旧实现：≥512 全部返回同一桶号
    expect(bucketOf(600)).not.toBe(bucketOf(2000));
    expect(bucketOf(1024)).not.toBe(bucketOf(4096));
    expect(bucketOf(512)).not.toBe(bucketOf(5120));
  });

  it("超大值与正常值不同桶", () => {
    expect(bucketOf(20)).not.toBe(bucketOf(2000));
    expect(bucketOf(100)).not.toBe(bucketOf(5000));
  });

  it("既有区间桶号保持不变（向后兼容）", () => {
    expect(bucketOf(0.5)).toBe(0);
    expect(bucketOf(1)).toBe(1);
    expect(bucketOf(2)).toBe(2);
    expect(bucketOf(4)).toBe(3);
    expect(bucketOf(8)).toBe(4);
    expect(bucketOf(511)).toBe(9);
    expect(bucketOf(512)).toBe(10);
  });

  it("canonical 中不同量级超大件可区分", () => {
    const a = buildSignature([feat("a", "POCKET", 600, 600)]);
    const b = buildSignature([feat("b", "POCKET", 3000, 3000)]);
    expect(a.canonical).not.toBe(b.canonical);
  });
});
