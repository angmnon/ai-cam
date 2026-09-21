/**
 * 历史工艺检索（P5-5）：把零件特征序列规范化为 Feature Signature，
 * 与历史 Job 的签名比对，返回相似工艺（内存索引 v1；pgvector 后续替换）。
 *
 * 签名设计（v1）：
 * - 归一化特征序列：按类型排序（可交换），每项 = 类型 + 尺寸分桶（对数分桶，尺寸缩放不敏感）；
 * - 相似度 = Jaccard(类型袋) × 0.6 + 尺寸匹配率 × 0.4。
 */
import type { Feature } from "@ai-cam/domain-schemas";

export interface SignatureItem {
  type: string;
  /** 尺寸分桶（mm，对数桶：1-2,2-4,4-8,8-16,16-32,32-64,64-128…） */
  depthBucket: number;
  sizeBucket: number;
}

export interface FeatureSignature {
  items: SignatureItem[];
  /** 排序后的规范串（可哈希/入库） */
  canonical: string;
}

export interface HistoryJob {
  job_id: string;
  part_name: string;
  /** 所属租户（P1-16：多租户隔离键） */
  orgId: string;
  /** 历史工艺摘要（供复用） */
  process_summary: string;
  operations_count: number;
  material?: string;
  created_at?: string;
  signature?: FeatureSignature;
}

export interface RetrievalHit {
  job: HistoryJob;
  score: number;
  /** 匹配解释（可解释） */
  reasons: string[];
}

/**
 * 对数分桶（P3-27）：[0,1)=0, [1,2)=1, [2,4)=2, [4,8)=3 … 无限向上扩展。
 * 旧实现把 ≥512 的值全部压进同一个哨兵桶，导致超大件与超大件同桶；
 * 现在按 log2 持续分桶，超大值之间彼此区分，且既有区间的桶号保持不变。
 */
export const bucketOf = (v: number): number => {
  const abs = Math.max(0, v);
  if (abs < 1) return 0;
  return Math.floor(Math.log2(abs)) + 1;
};

function featureSignatureItems(features: Feature[]): SignatureItem[] {
  return features.map((f) => {
    const d = f.dimensions?.depth_mm ?? (f.bbox.max.z - f.bbox.min.z);
    const w = Math.max(f.bbox.max.x - f.bbox.min.x, f.bbox.max.y - f.bbox.min.y);
    return { type: f.type, depthBucket: bucketOf(d), sizeBucket: bucketOf(w) };
  });
}

export function buildSignature(features: Feature[]): FeatureSignature {
  const items = featureSignatureItems(features).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.sizeBucket - b.sizeBucket || a.depthBucket - b.depthBucket));
  const canonical = items.map((i) => `${i.type}#${i.sizeBucket}#${i.depthBucket}`).join("|");
  return { items, canonical };
}

export function signatureDistance(a: FeatureSignature, b: FeatureSignature): { score: number; reasons: string[] } {
  const typeA = new Set(a.items.map((i) => i.type));
  const typeB = new Set(b.items.map((i) => i.type));
  const inter = [...typeA].filter((t) => typeB.has(t)).length;
  const union = new Set([...typeA, ...typeB]).size;
  const typeJaccard = union === 0 ? 1 : inter / union;
  // 尺寸匹配：同类型项逐一配对（贪心最近桶）
  let matched = 0;
  let total = 0;
  for (const ia of a.items) {
    const cand = b.items.filter((ib) => ib.type === ia.type);
    if (cand.length === 0) continue;
    total += 1;
    const best = Math.min(...cand.map((ib) => Math.abs(ib.sizeBucket - ia.sizeBucket) + Math.abs(ib.depthBucket - ia.depthBucket)));
    if (best <= 1) matched += 1;
  }
  const dimScore = total === 0 ? 0 : matched / total;
  const score = typeJaccard * 0.6 + dimScore * 0.4;
  const reasons = [`类型相似度(Jaccard) ${typeJaccard.toFixed(2)}`, `尺寸匹配率 ${dimScore.toFixed(2)}（桶差≤1）`];
  return { score, reasons };
}

export class ProcessIndex {
  private jobs: HistoryJob[] = [];
  constructor(private threshold = 0.5) {}

  add(job: HistoryJob, features: Feature[], orgId: string): void {
    this.jobs.push({ ...job, orgId, signature: buildSignature(features) });
  }

  size(): number {
    return this.jobs.length;
  }

  search(features: Feature[], orgId: string, topK = 3): RetrievalHit[] {
    const sig = buildSignature(features);
    // P1-16：租户隔离——只在当前 org 内检索，绝不跨租户返回
    return this.jobs
      .filter((job) => job.orgId === orgId)
      .map((job) => {
        if (!job.signature) return null;
        const { score, reasons } = signatureDistance(sig, job.signature);
        return { job, score, reasons };
      })
      .filter((h): h is RetrievalHit => h !== null && h.score >= this.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
