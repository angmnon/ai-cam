/**
 * P0-01：parts 域 PostgreSQL 实现（表：parts / part_analysis，迁移 0002）。
 * P1-07：所有读写经 withOrgScope 绑定 app.org_id，RLS 在 DB 层强制多租户隔离；
 *        应用层 organization_id 过滤作为第二道防线。
 * - analysis 以 JSONB 落 part_analysis；内存版接口语义对齐。
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import type { PartStore, PartRecord, PartAnalysis, CreatePartInput, PartStatus } from "../../parts/part-store.js";
import { withOrgScope } from "../org-scope.js";

interface PartRow {
  id: string;
  organization_id: string;
  filename: string;
  content_type: string;
  size_bytes: string | number;
  status: string;
  source_key: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  part_json: unknown;
  feature_graph: unknown;
  dfm_report: unknown;
  mesh_key: string | null;
}

function rowToRecord(row: PartRow): PartRecord {
  const rec: PartRecord = {
    id: row.id,
    organization_id: row.organization_id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: Number(row.size_bytes),
    status: row.status as PartStatus,
    source_key: row.source_key,
    created_by: row.created_by ?? "",
    created_at: (row.created_at as unknown as Date)?.toISOString?.() ?? String(row.created_at),
    updated_at: (row.updated_at as unknown as Date)?.toISOString?.() ?? String(row.updated_at),
  };
  if (row.part_json && row.feature_graph && row.dfm_report) {
    const analysis: PartAnalysis = {
      part: row.part_json as PartAnalysis["part"],
      features: row.feature_graph as PartAnalysis["features"],
      dfm: row.dfm_report as PartAnalysis["dfm"],
      ...(row.mesh_key ? { mesh_key: row.mesh_key } : {}),
    };
    rec.analysis = analysis;
  }
  return rec;
}

const SELECT_WITH_ANALYSIS = `
  SELECT p.*, a.part_json, a.feature_graph, a.dfm_report, a.mesh_key
  FROM parts p
  LEFT JOIN part_analysis a ON a.part_id = p.id`;

export function createPgPartStore(pool: Pool): PartStore {
  return {
    async create(input: CreatePartInput): Promise<PartRecord> {
      const id = `part_${randomUUID().replaceAll("-", "")}`;
      return withOrgScope(pool, input.orgId, async (client) => {
        const { rows } = await client.query<PartRow>(
          `INSERT INTO parts (id, organization_id, filename, content_type, size_bytes, status, source_key, created_by)
           VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7)
           RETURNING *`,
          [id, input.orgId, input.filename, input.content_type, input.size_bytes, input.source_key, input.userId],
        );
        return rowToRecord(rows[0]);
      });
    },

    async get(orgId: string, partId: string): Promise<PartRecord> {
      return withOrgScope(pool, orgId, async (client) => {
        const { rows } = await client.query<PartRow>(`${SELECT_WITH_ANALYSIS} WHERE p.id = $1 AND p.organization_id = $2`, [partId, orgId]);
        const row = rows[0];
        if (!row) {
          // 与内存版一致：跨租户/不存在统一 NOT_FOUND（不泄漏是否存在）
          throw new ApiError({ code: ErrorCodes.PART_NOT_FOUND, message: `Part not found: ${partId}`, stage: "parts" });
        }
        return rowToRecord(row);
      });
    },

    async list(orgId: string, opts: { status?: PartStatus; offset: number; limit: number }) {
      return withOrgScope(pool, orgId, async (client) => {
        const where: string[] = ["p.organization_id = $1"];
        const params: unknown[] = [orgId];
        if (opts.status) {
          params.push(opts.status);
          where.push(`p.status = $${params.length}`);
        }
        params.push(opts.offset, opts.limit);
        const offsetIdx = params.length - 1;
        const limitIdx = params.length - 2;
        const { rows } = await client.query<PartRow>(
          `${SELECT_WITH_ANALYSIS}
           WHERE ${where.join(" AND ")}
           ORDER BY p.created_at DESC
           OFFSET $${limitIdx} LIMIT $${offsetIdx}`,
          params,
        );
        const countParams = [orgId, ...(opts.status ? [opts.status] : [])];
        const countWhere = ["organization_id = $1", ...(opts.status ? [`status = $2`] : [])];
        const cnt = await client.query<{ n: string }>(`SELECT count(*)::int AS n FROM parts WHERE ${countWhere.join(" AND ")}`, countParams);
        return { items: rows.map(rowToRecord), total: Number(cnt.rows[0]?.n ?? 0) };
      });
    },

    async setAnalysis(orgId: string, partId: string, analysis: PartAnalysis): Promise<PartRecord> {
      return withOrgScope(pool, orgId, async (client) => {
        // 租户校验（RLS 已兜底，此处保持接口语义一致）
        const chk = await client.query<PartRow>(`${SELECT_WITH_ANALYSIS} WHERE p.id = $1 AND p.organization_id = $2`, [partId, orgId]);
        if (!chk.rows[0]) throw new ApiError({ code: ErrorCodes.PART_NOT_FOUND, message: `Part not found: ${partId}`, stage: "parts" });
        await client.query(
          `INSERT INTO part_analysis (part_id, part_json, feature_graph, dfm_report, mesh_key, analyzed_at)
           VALUES ($1,$2,$3,$4,$5, now())
           ON CONFLICT (part_id) DO UPDATE SET part_json = EXCLUDED.part_json, feature_graph = EXCLUDED.feature_graph, dfm_report = EXCLUDED.dfm_report, mesh_key = EXCLUDED.mesh_key, analyzed_at = now()`,
          [partId, JSON.stringify(analysis.part), JSON.stringify(analysis.features), JSON.stringify(analysis.dfm), analysis.mesh_key ?? null],
        );
        await client.query(`UPDATE parts SET status = 'ANALYZED', updated_at = now() WHERE id = $1 AND organization_id = $2`, [partId, orgId]);
        const after = await client.query<PartRow>(`${SELECT_WITH_ANALYSIS} WHERE p.id = $1 AND p.organization_id = $2`, [partId, orgId]);
        return rowToRecord(after.rows[0]);
      });
    },

    async fail(orgId: string, partId: string, failure: { code: string; message: string; stage?: string }): Promise<PartRecord> {
      return withOrgScope(pool, orgId, async (client) => {
        const chk = await client.query<PartRow>(`${SELECT_WITH_ANALYSIS} WHERE p.id = $1 AND p.organization_id = $2`, [partId, orgId]);
        if (!chk.rows[0]) throw new ApiError({ code: ErrorCodes.PART_NOT_FOUND, message: `Part not found: ${partId}`, stage: "parts" });
        await client.query(`UPDATE parts SET status = 'FAILED', updated_at = now() WHERE id = $1 AND organization_id = $2`, [partId, orgId]);
        const after = await client.query<PartRow>(`${SELECT_WITH_ANALYSIS} WHERE p.id = $1 AND p.organization_id = $2`, [partId, orgId]);
        const rec = rowToRecord(after.rows[0]);
        // failure 明细不属权威 schema 列，按内存版语义挂在返回记录上（路由随后抛错）
        rec.failure = { code: failure.code, message: failure.message, ...(failure.stage ? { stage: failure.stage } : {}) };
        return rec;
      });
    },
  };
}
