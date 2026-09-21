/**
 * P0-01：CAM 修订版 PostgreSQL 实现（表：cam_revisions，迁移 0003）。
 * P1-07：经 withOrgScope 绑定 app.org_id，RLS 强制多租户隔离。
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { CamIR } from "@ai-cam/cam-ir";
import type { CamStore, CamRevision } from "../../cam/cam-store.js";
import { withOrgScope } from "../org-scope.js";

interface Row {
  id: string;
  organization_id: string;
  part_id: string;
  revision_no: string | number;
  status: string;
  engine_version: string;
  cam_ir_json: CamIR;
  created_by: string | null;
  created_at: Date;
}

function rowToRevision(row: Row): CamRevision {
  return {
    id: row.id,
    organization_id: row.organization_id,
    part_id: row.part_id,
    revision_no: Number(row.revision_no),
    status: row.status as CamRevision["status"],
    engine_version: row.engine_version,
    cam: row.cam_ir_json,
    created_by: row.created_by ?? "",
    created_at: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
  };
}

export function createPgCamStore(pool: Pool): CamStore {
  return {
    async create({ orgId, partId, userId, cam }): Promise<CamRevision> {
      return withOrgScope(pool, orgId, async (client) => {
        const { rows: existing } = await client.query<Row>(
          `SELECT * FROM cam_revisions WHERE part_id = $1 AND organization_id = $2 ORDER BY revision_no DESC`,
          [partId, orgId],
        );
        const revisionNo = Number(existing[0]?.revision_no ?? 0) + 1;
        const { rows } = await client.query<Row>(
          `INSERT INTO cam_revisions (id, organization_id, part_id, revision_no, status, engine_version, cam_ir_json, created_by)
           VALUES ($1,$2,$3,$4,'READY',$5,$6,$7)
           RETURNING *`,
          [`cam_${randomUUID().replaceAll("-", "")}`, orgId, partId, revisionNo, cam.metadata?.generator_version ?? "0.0.0", JSON.stringify(cam), userId],
        );
        return rowToRevision(rows[0]);
      });
    },

    async latest(orgId: string, partId: string): Promise<CamRevision | null> {
      return withOrgScope(pool, orgId, async (client) => {
        const { rows } = await client.query<Row>(
          `SELECT * FROM cam_revisions WHERE part_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1`,
          [partId, orgId],
        );
        return rows[0] ? rowToRevision(rows[0]) : null;
      });
    },

    async list(orgId: string, partId: string): Promise<CamRevision[]> {
      return withOrgScope(pool, orgId, async (client) => {
        const { rows } = await client.query<Row>(
          `SELECT * FROM cam_revisions WHERE part_id = $1 AND organization_id = $2 ORDER BY created_at DESC`,
          [partId, orgId],
        );
        return rows.map(rowToRevision);
      });
    },
  };
}
