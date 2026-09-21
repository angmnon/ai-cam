/** P0-01：PostgreSQL 连接池。连接串一律来自环境变量 DATABASE_URL（config.databaseUrl）。 */
import { Pool } from "pg";

/** 从 DATABASE_URL 构造连接池；生产连接数适中，避免每请求新建连接 */
export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    // 本地开发/单实例默认值；线上由 PgBouncer / 连接代理前置
    max: Number(process.env.PG_POOL_MAX ?? 10) || 10,
    idleTimeoutMillis: 30_000,
  });
}
