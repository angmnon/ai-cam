/**
 * CAM 修订版存储（P2-8 进程内实现；SQL 0003 落库后同接口）。
 * 每次 POST /parts/:id/toolpath 生成一个新 revision；GET 返回最新。
 */
import { randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import type { CamIR } from "@ai-cam/cam-ir";

export interface CamRevision {
  id: string;
  organization_id: string;
  part_id: string;
  revision_no: number;
  status: "READY" | "FAILED";
  engine_version: string;
  cam: CamIR;
  created_by: string;
  created_at: string;
}

export interface CamStore {
  create(input: { orgId: string; partId: string; userId: string; cam: CamIR }): Promise<CamRevision>;
  latest(orgId: string, partId: string): Promise<CamRevision | null>;
  list(orgId: string, partId: string): Promise<CamRevision[]>;
}

export function createCamStore(): CamStore {
  const revisions = new Map<string, CamRevision>();

  return {
    async create({ orgId, partId, userId, cam }) {
      const existing = [...revisions.values()].filter((r) => r.part_id === partId && r.organization_id === orgId);
      const revision: CamRevision = {
        id: `cam_${randomUUID().replaceAll("-", "")}`,
        organization_id: orgId,
        part_id: partId,
        revision_no: existing.length + 1,
        status: "READY",
        engine_version: cam.metadata?.generator_version ?? "0.0.0",
        cam,
        created_by: userId,
        created_at: new Date().toISOString(),
      };
      revisions.set(revision.id, revision);
      return revision;
    },
    async latest(orgId, partId) {
      const hits = [...revisions.values()]
        .filter((r) => r.part_id === partId && r.organization_id === orgId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return hits[0] ?? null;
    },
    async list(orgId, partId) {
      return [...revisions.values()]
        .filter((r) => r.part_id === partId && r.organization_id === orgId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    },
  };
}

export async function mustLatest(store: CamStore, orgId: string, partId: string): Promise<CamRevision> {
  const rev = await store.latest(orgId, partId);
  if (!rev) {
    throw new ApiError({ code: ErrorCodes.CAM_REVISION_NOT_FOUND, message: "No CAM revision for this part yet. POST /toolpath first.", stage: "cam", retryable: false });
  }
  return rev;
}
