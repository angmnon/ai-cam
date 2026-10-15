/**
 * P1-07 多租户隔离作用域（方案 C 起支持双后端）。
 *
 * PG 后端（原行为不变）：
 *   withOrgScope(pool, orgId, fn)：
 *     BEGIN → SET LOCAL ROLE aicam_app（NOBYPASSRLS，绕过 superuser 的 RLS 豁免）
 *           → SET LOCAL app.org_id = orgId → 在事务内执行 fn(client) → COMMIT
 *   异常即 ROLLBACK 并释放连接。配合迁移 0007 的 RLS POLICY：DB 层强制 org 隔离。
 *
 * D1 后端（Cloudflare，迁移 0007 无 RLS）：
 *   用 D1Database.withSession() 提供事务性会话；多租户隔离由 store SQL 显式
 *   organization_id 过滤承担（方案 C C.4 工作项 #3），本函数作为统一入口保证
 *   所有业务读写必经同一作用域，并为后续审计/指标埋点保留扩展点。
 *
 * 仅依赖 pg（PG 路径）与 node 原生（D1 路径），零新运行依赖。
 */
import type { PoolClient } from "pg";
import { D1SessionClient, isD1, type D1DatabaseLike, type SqlDb } from "./d1/d1-client.js";
export type { SqlDb } from "./d1/d1-client.js";

/** 应用 DB 角色（PG 迁移 0007 创建，NOBYPASSRLS）；可用环境变量 DB_APP_ROLE 覆盖 */
const DEFAULT_APP_ROLE = process.env.DB_APP_ROLE ?? "aicam_app";

/** SQL 标识符白名单：仅字母/数字/下划线，且以字母/下划线开头（SET ROLE 无法参数化） */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface OrgScopeOptions {
  /** 非超级用户应用角色（SET LOCAL ROLE）；传 null/空串则跳过 SET ROLE（连接本身即非 bypass 角色时用） */
  appRole?: string;
}

/** D1 路径：事务会话内执行 fn；会话异常自动回滚（D1 withSession 语义） */
async function withD1Scope<TResult>(db: D1DatabaseLike, fn: (client: PoolClient) => Promise<TResult>): Promise<TResult> {
  return db.withSession(async (session) => {
    const client = new D1SessionClient(session) as unknown as PoolClient;
    return fn(client);
  });
}

/**
 * 在绑定 org_id 的事务/会话内执行 fn。
 * PG 分支传入 PoolClient；D1 分支传入 D1SessionClient（运行时保证）。
 * fn 的 client 参数标注为 PoolClient：D1SessionClient 实现了 store 实际使用面的
 * 全部形态（query<R>(sql, params) → Promise<{ rows: R[] }>、scalar），两者在该子集上
 * 形状一致，因此联合类型下无法调用的问题可避免，且 store 的泛型标注不受影响。
 * fn 收到的 client 必须在该作用域内使用，不得泄漏到作用域外。
 */
export async function withOrgScope<TResult>(
  db: SqlDb,
  orgId: string,
  fn: (client: PoolClient) => Promise<TResult>,
  opts: OrgScopeOptions = {},
): Promise<TResult> {
  // ---- D1 后端（无 RLS；org_id 过滤由 store SQL 承担）----
  if (isD1(db)) {
    return withD1Scope(db, fn);
  }

  // ---- PG 后端（RLS 兜底，原语义不变）----
  const appRole = opts.appRole ?? DEFAULT_APP_ROLE;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL 随事务结束自动复位；superuser 切换到 NOBYPASSRLS 角色后 RLS 生效。
    // 角色名无法参数化，必须先白名单校验，杜绝标识符注入。
    if (appRole) {
      if (!SAFE_IDENT.test(appRole)) {
        throw new Error(`Invalid DB_APP_ROLE: ${appRole}`);
      }
      await client.query(`SET LOCAL ROLE ${appRole}`);
    }
    // set_config(..., true) = SET LOCAL，参数化注入安全
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
