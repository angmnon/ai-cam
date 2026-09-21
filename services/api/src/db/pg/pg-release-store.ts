/**
 * P0-01：Release 工作流 PostgreSQL 实现（表：releases / release_approvals，迁移 0005）。
 * - 所有查询强制带 organization_id 过滤；审批链审计落 release_approvals。
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import type { ReleaseStore, ReleaseRecord, ReleaseStatus } from "../../cam/release-store.js";

interface Row {
  id: string;
  organization_id: string;
  part_id: string;
  cam_revision_id: string;
  job_run_id: string;
  version_no: string | number;
  status: string;
  requested_by: string;
  approved_by: string | null;
  approval_note: string | null;
  qr_token: string | null;
  created_at: Date;
  approved_at: Date | null;
  released_at: Date | null;
}

function rowToRelease(row: Row): ReleaseRecord {
  return {
    id: row.id,
    organization_id: row.organization_id,
    part_id: row.part_id,
    cam_revision_id: row.cam_revision_id,
    job_run_id: row.job_run_id,
    version_no: Number(row.version_no),
    status: row.status as ReleaseStatus,
    requested_by: row.requested_by,
    ...(row.approved_by ? { approved_by: row.approved_by } : {}),
    ...(row.approval_note ? { approval_note: row.approval_note } : {}),
    qr_token: row.qr_token ?? "",
    created_at: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
    ...(row.approved_at ? { approved_at: row.approved_at.toISOString() } : {}),
    ...(row.released_at ? { released_at: row.released_at.toISOString() } : {}),
  };
}

async function auditApproval(pool: Pool, releaseId: string, approverId: string, action: "APPROVE" | "REJECT", note?: string): Promise<void> {
  await pool.query(
    `INSERT INTO release_approvals (id, release_id, approver_id, action, note) VALUES ($1,$2,$3,$4,$5)`,
    [`ap_${randomUUID().replaceAll("-", "")}`, releaseId, approverId, action, note ?? null],
  );
}

export function createPgReleaseStore(pool: Pool): ReleaseStore {
  return {
    async create({ orgId, partId, camRevisionId, jobRunId, userId }): Promise<ReleaseRecord> {
      const { rows: existing } = await pool.query<Row>(
        `SELECT * FROM releases WHERE part_id = $1 AND organization_id = $2 ORDER BY version_no DESC LIMIT 1`,
        [partId, orgId],
      );
      const versionNo = Number(existing[0]?.version_no ?? 0) + 1;
      const id = `rel_${randomUUID().replaceAll("-", "")}`;
      const { rows } = await pool.query<Row>(
        `INSERT INTO releases (id, organization_id, part_id, cam_revision_id, job_run_id, version_no, status, requested_by, qr_token)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING_APPROVAL',$7,$8)
         RETURNING *`,
        [id, orgId, partId, camRevisionId, jobRunId, versionNo, userId, `qr_${randomUUID().replaceAll("-", "").slice(0, 16)}`],
      );
      return rowToRelease(rows[0]);
    },

    async list(orgId: string, partId: string): Promise<ReleaseRecord[]> {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM releases WHERE part_id = $1 AND organization_id = $2 ORDER BY version_no DESC`,
        [partId, orgId],
      );
      return rows.map(rowToRelease);
    },

    async get(orgId: string, partId: string, releaseId: string): Promise<ReleaseRecord> {
      const { rows } = await pool.query<Row>(`SELECT * FROM releases WHERE id = $1 AND part_id = $2 AND organization_id = $3`, [releaseId, partId, orgId]);
      if (!rows[0]) throw new ApiError({ code: ErrorCodes.RELEASE_NOT_FOUND, message: "Release not found.", stage: "releases", retryable: false });
      return rowToRelease(rows[0]);
    },

    async approve({ orgId, partId, releaseId, approverId, note }): Promise<ReleaseRecord> {
      const r = await this.get(orgId, partId, releaseId);
      if (r.status !== "PENDING_APPROVAL") throw new ApiError({ code: ErrorCodes.RELEASE_STATE_INVALID, message: `Release is ${r.status}, only PENDING_APPROVAL can be approved.`, stage: "releases", retryable: false });
      const { rows } = await pool.query<Row>(
        `UPDATE releases SET status = 'APPROVED', approved_by = $1, approval_note = $2, approved_at = now() WHERE id = $3 RETURNING *`,
        [approverId, note ?? null, releaseId],
      );
      await auditApproval(pool, releaseId, approverId, "APPROVE", note);
      return rowToRelease(rows[0]);
    },

    async release({ orgId, partId, releaseId, approverId, note }): Promise<ReleaseRecord> {
      const r = await this.get(orgId, partId, releaseId);
      if (r.status !== "APPROVED") throw new ApiError({ code: ErrorCodes.RELEASE_STATE_INVALID, message: `Release is ${r.status}, only APPROVED can be released.`, stage: "releases", retryable: false });
      const { rows } = await pool.query<Row>(
        `UPDATE releases SET status = 'RELEASED', approved_by = $1, approval_note = COALESCE($2, approval_note), released_at = now() WHERE id = $3 RETURNING *`,
        [approverId, note ?? null, releaseId],
      );
      return rowToRelease(rows[0]);
    },

    async reject({ orgId, partId, releaseId, approverId, note }): Promise<ReleaseRecord> {
      const r = await this.get(orgId, partId, releaseId);
      if (r.status === "RELEASED") throw new ApiError({ code: ErrorCodes.RELEASE_STATE_INVALID, message: "RELEASED 为终态，不可驳回。", stage: "releases", retryable: false });
      const { rows } = await pool.query<Row>(
        `UPDATE releases SET status = 'REJECTED', approved_by = $1, approval_note = $2 WHERE id = $3 RETURNING *`,
        [approverId, note, releaseId],
      );
      await auditApproval(pool, releaseId, approverId, "REJECT", note);
      return rowToRelease(rows[0]);
    },
  };
}
