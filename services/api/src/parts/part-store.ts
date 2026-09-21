/** 零件记录与流水线状态（Phase 1 进程内实现；迁移 0002 落库后同接口） */
import { randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import type { DfmReport } from "@ai-cam/dfm";
import type { FeatureGraph } from "@ai-cam/domain-schemas";
import type { NormalizedPartModel } from "@ai-cam/geometry-schema";

export type PartStatus = "PENDING" | "PARSING" | "ANALYZED" | "FAILED";

export interface PartAnalysis {
  part: NormalizedPartModel;
  features: FeatureGraph;
  dfm: DfmReport;
  /** VIEW_MESH 对象存储 key（OBJ），可能为空 */
  mesh_key?: string;
}

export interface PartRecord {
  id: string;
  organization_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: PartStatus;
  /** CAD_SOURCE 对象存储 key */
  source_key: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  analysis?: PartAnalysis;
  failure?: { code: string; message: string; stage?: string };
}

export interface CreatePartInput {
  orgId: string;
  userId: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  source_key: string;
}

export interface PartStore {
  create(input: CreatePartInput): Promise<PartRecord>;
  get(orgId: string, partId: string): Promise<PartRecord>;
  list(orgId: string, opts: { status?: PartStatus; offset: number; limit: number }): Promise<{ items: PartRecord[]; total: number }>;
  setAnalysis(orgId: string, partId: string, analysis: PartAnalysis): Promise<PartRecord>;
  fail(orgId: string, partId: string, failure: { code: string; message: string; stage?: string }): Promise<PartRecord>;
}

export function createPartStore(): PartStore {
  const parts = new Map<string, PartRecord>();

  function mustGet(orgId: string, partId: string): PartRecord {
    const part = parts.get(partId);
    if (!part) throw new ApiError({ code: ErrorCodes.PART_NOT_FOUND, message: `Part not found: ${partId}`, stage: "parts" });
    if (part.organization_id !== orgId) {
      throw new ApiError({ code: ErrorCodes.AUTH_FORBIDDEN, message: "Part does not belong to this organization.", stage: "parts" });
    }
    return part;
  }

  function save(part: PartRecord): PartRecord {
    parts.set(part.id, part);
    return part;
  }

  return {
    async create(input) {
      const now = new Date().toISOString();
      const part: PartRecord = {
        id: `part_${randomUUID().replaceAll("-", "")}`,
        organization_id: input.orgId,
        filename: input.filename,
        content_type: input.content_type,
        size_bytes: input.size_bytes,
        status: "PENDING",
        source_key: input.source_key,
        created_by: input.userId,
        created_at: now,
        updated_at: now,
      };
      return save(part);
    },
    async get(orgId, partId) {
      return mustGet(orgId, partId);
    },
    async list(orgId, { status, offset, limit }) {
      const all = [...parts.values()].filter((p) => p.organization_id === orgId && (!status || p.status === status));
      all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      // P2-52：内存分页，语义对齐 SQL OFFSET ? LIMIT ?（offset 跳过、limit 截断）
      return { items: all.slice(offset, offset + limit), total: all.length };
    },
    async setAnalysis(orgId, partId, analysis) {
      const part = mustGet(orgId, partId);
      part.analysis = analysis;
      part.status = "ANALYZED";
      part.updated_at = new Date().toISOString();
      return save(part);
    },
    async fail(orgId, partId, failure) {
      const part = mustGet(orgId, partId);
      part.status = "FAILED";
      part.failure = failure;
      part.updated_at = new Date().toISOString();
      return save(part);
    },
  };
}
