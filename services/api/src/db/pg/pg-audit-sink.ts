/**
 * P1-08：PostgreSQL 审计 sink（表：audit_logs，迁移 0001 + 0007 补列）。
 *
 * 实现 @ai-cam/security 的 AuditSink.append，并提供 queryAudit 读回。
 * - append：insert 一行；organization_id 暂置 NULL（全局审计行，RLS 策略允许 NULL 行读写），
 *   完整事件（含 actor/role/action/resource/outcome）落 payload JSONB。
 * - queryAudit：按 actor/action/outcome 过滤，按时间倒序返回。
 *
 * 仅依赖 pg，零新运行依赖。
 */
import type { Pool } from "pg";
import type { AuditEvent } from "@ai-cam/security";

export interface AuditQueryFilter {
  actor?: string;
  action?: string;
  outcome?: AuditEvent["outcome"];
  limit?: number;
}

export class PgAuditSink {
  constructor(private readonly pool: Pool) {}

  /** AuditSink 接口：追加一条审计事件 */
  async append(ev: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_id, actor, outcome, details, payload)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $6)`,
      [ev.actor, ev.action, ev.resource, ev.actor, ev.outcome, JSON.stringify(ev)],
    );
  }

  /** 按过滤条件读回审计事件（时间倒序） */
  async queryAudit(filter: AuditQueryFilter = {}): Promise<AuditEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.actor) {
      params.push(filter.actor);
      where.push(`actor = $${params.length}`);
    }
    if (filter.action) {
      params.push(filter.action);
      where.push(`action = $${params.length}`);
    }
    if (filter.outcome) {
      params.push(filter.outcome);
      where.push(`outcome = $${params.length}`);
    }
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
    const sql = `SELECT payload FROM audit_logs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    const { rows } = await this.pool.query<{ payload: AuditEvent }>(sql, [...params, limit]);
    return rows.map((r) => r.payload);
  }
}
