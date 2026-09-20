/**
 * Release 工作流存储（P4-11）：内存实现（SQL 0005 落库后同接口）。
 * 审批链 v1：PENDING_APPROVAL → APPROVED → RELEASED（可 REJECTED）。
 */
import { randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";

export type ReleaseStatus = "PENDING_APPROVAL" | "APPROVED" | "RELEASED" | "REJECTED";

export interface ReleaseRecord {
  id: string;
  organization_id: string;
  part_id: string;
  cam_revision_id: string;
  job_run_id: string;
  version_no: number;
  status: ReleaseStatus;
  requested_by: string;
  approved_by?: string;
  approval_note?: string;
  qr_token: string;
  created_at: string;
  approved_at?: string;
  released_at?: string;
}

export interface ReleaseStore {
  create(input: { orgId: string; partId: string; camRevisionId: string; jobRunId: string; userId: string }): ReleaseRecord;
  list(orgId: string, partId: string): ReleaseRecord[];
  get(orgId: string, partId: string, releaseId: string): ReleaseRecord;
  approve(input: { orgId: string; partId: string; releaseId: string; approverId: string; note?: string }): ReleaseRecord;
  release(input: { orgId: string; partId: string; releaseId: string; approverId: string; note?: string }): ReleaseRecord;
  reject(input: { orgId: string; partId: string; releaseId: string; approverId: string; note: string }): ReleaseRecord;
}

export function createReleaseStore(): ReleaseStore {
  const byId = new Map<string, ReleaseRecord>();
  const byPart = (orgId: string, partId: string) =>
    [...byId.values()].filter((r) => r.part_id === partId && r.organization_id === orgId).sort((a, b) => b.version_no - a.version_no);

  return {
    create({ orgId, partId, camRevisionId, jobRunId, userId }) {
      const rec: ReleaseRecord = {
        id: `rel_${randomUUID().replaceAll("-", "")}`,
        organization_id: orgId,
        part_id: partId,
        cam_revision_id: camRevisionId,
        job_run_id: jobRunId,
        version_no: (byPart(orgId, partId)[0]?.version_no ?? 0) + 1,
        status: "PENDING_APPROVAL",
        requested_by: userId,
        qr_token: `qr_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        created_at: new Date().toISOString(),
      };
      byId.set(rec.id, rec);
      return rec;
    },
    list(orgId, partId) {
      return byPart(orgId, partId);
    },
    get(orgId, partId, releaseId) {
      const r = byId.get(releaseId);
      if (!r || r.part_id !== partId || r.organization_id !== orgId) throw new ApiError({ code: ErrorCodes.RELEASE_NOT_FOUND, message: "Release not found.", stage: "releases", retryable: false });
      return r;
    },
    approve({ orgId, partId, releaseId, approverId, note }) {
      const r = this.get(orgId, partId, releaseId);
      if (r.status !== "PENDING_APPROVAL") throw new ApiError({ code: ErrorCodes.RELEASE_STATE_INVALID, message: `Release is ${r.status}, only PENDING_APPROVAL can be approved.`, stage: "releases", retryable: false });
      r.status = "APPROVED";
      r.approved_by = approverId;
      r.approval_note = note;
      r.approved_at = new Date().toISOString();
      return r;
    },
    release({ orgId, partId, releaseId, approverId, note }) {
      const r = this.get(orgId, partId, releaseId);
      if (r.status !== "APPROVED") throw new ApiError({ code: ErrorCodes.RELEASE_STATE_INVALID, message: `Release is ${r.status}, only APPROVED can be released.`, stage: "releases", retryable: false });
      r.status = "RELEASED";
      r.approved_by = approverId;
      if (note) r.approval_note = note;
      r.released_at = new Date().toISOString();
      return r;
    },
    reject({ orgId, partId, releaseId, approverId, note }) {
      const r = this.get(orgId, partId, releaseId);
      if (r.status === "RELEASED") throw new ApiError({ code: ErrorCodes.RELEASE_STATE_INVALID, message: "RELEASED 为终态，不可驳回。", stage: "releases", retryable: false });
      r.status = "REJECTED";
      r.approved_by = approverId;
      r.approval_note = note;
      return r;
    },
  };
}
