/**
 * D1 数据访问适配层（方案 C · Phase 7 工作项 #2）。
 *
 * ⚠️ 该后端（Cloudflare D1 / SQLite）已于 2026-10 废弃并清理：
 *   迁移路线统一为 Postgres（`infra/db/migrations`），`org-scope` 与 `pg-audit-sink`
 *   仅保留 PG 路径。本文件仅恢复类型与导出，使既有消费方（src 引用）可编译；
 *   D1 分支实现一律抛错——运行时只走 PG，不会触达。
 *
 * 历史职责（保留签名，供阅读）：
 *   1. SQL 转换：$n → ?；now() → strftime ISO；::type 剥除。
 *   2. JSON/数组列自动 parse。
 *   3. 事务会话：D1Database.withSession()。
 */
import type { Pool } from "pg";

/** 统一数据库句柄：pg Pool（原后端）或 D1 Database（Cloudflare，Duck-Typing） */
export type SqlDb = Pool | D1DatabaseLike;

/** D1 会话内 prepared statement（最小接口，与 D1 运行时形状一致） */
export interface D1SessionStatement {
  bind(...args: unknown[]): D1SessionStatement;
  all(): Promise<{ results: unknown[]; success: boolean }>;
  run(): Promise<{ success: boolean; meta?: unknown }>;
  first(): Promise<unknown>;
}

/** D1 事务会话（withSession 回调参数） */
export interface D1Session {
  prepare(sql: string): D1SessionStatement;
}

/** D1Database 最小接口（Duck-Typing，不引 workers-types） */
export interface D1DatabaseLike {
  prepare(sql: string): D1SessionStatement;
  withSession<T>(fn: (session: D1Session) => Promise<T>): Promise<T>;
  batch<T = unknown>(statements: unknown[]): Promise<T[]>;
}

/** 判断一个数据库句柄是否为 D1（vs pg Pool） */
export function isD1(_db: unknown): _db is D1DatabaseLike {
  throw new Error("D1 backend is deprecated; only the Postgres backend is supported.");
}

/** 转换 SQL：now() → strftime ISO；::type 剥除；$n → ?（bind 按出现顺序展开） */
export function convertSql(sql: string, params: unknown[]): { sql: string; bind: unknown[] } {
  let i = 0;
  const out = sql.replace(/\$(\d+)/g, () => `?`).replace(/::(int|text|numeric|timestamp|uuid|bool)/gi, "");
  void i;
  return { sql: out.replace(/now\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"), bind: params };
}

/** 按 JSON 列清单 parse 单行；非清单列保持原值 */
export function parseRow(row: Record<string, unknown>): Record<string, unknown> {
  return row;
}

/**
 * 事务会话内的查询客户端：签名与 pg PoolClient.query 兼容（返回 { rows }）。
 * D1 已废弃，调用即抛错。
 */
export class D1SessionClient {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_session: D1Session) {
    throw new Error("D1 backend is deprecated; only the Postgres backend is supported.");
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  query<T = Record<string, unknown>>(_sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
    throw new Error("D1 backend is deprecated; only the Postgres backend is supported.");
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  scalar<T = unknown>(_sql: string, _params?: unknown[]): Promise<T | undefined> {
    throw new Error("D1 backend is deprecated; only the Postgres backend is supported.");
  }
}

/** 无事务裸查询（审计 sink / bootstrap 等不走 org 作用域时用）。D1 已废弃，调用即抛错。 */
export function runDbQuery<T = Record<string, unknown>>(
  _db: SqlDb,
  _sql: string,
  _params?: unknown[],
): Promise<{ rows: T[] }> {
  throw new Error("D1 backend is deprecated; only the Postgres backend is supported.");
}
