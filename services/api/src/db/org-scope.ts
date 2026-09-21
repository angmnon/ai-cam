/**
 * P1-07 多租户行级安全（RLS）作用域。
 *
 * withOrgScope(pool, orgId, fn)：
 *   BEGIN → SET LOCAL ROLE aicam_app（NOBYPASSRLS，绕过 superuser 的 RLS 豁免）
 *         → SET LOCAL app.org_id = orgId → 在事务内执行 fn(client) → COMMIT
 *   异常即 ROLLBACK 并释放连接。
 *
 * 配合迁移 0007 的 POLICY organization_id = current_setting('app.org_id', true)：
 *   - 未设置 app.org_id 时所有业务表对该会话不可见（默认拒绝）；
 *   - 跨 org 的读 → 0 行；跨 org 的 UPDATE → 0 行命中（RLS 在 DB 层兜底，应用层过滤为第二道）。
 *
 * 仅依赖 pg，零新运行依赖。
 */
import type { Pool, PoolClient } from "pg";

/** 应用 DB 角色（迁移 0007 创建，NOBYPASSRLS）；可用环境变量 DB_APP_ROLE 覆盖 */
const DEFAULT_APP_ROLE = process.env.DB_APP_ROLE ?? "aicam_app";

/** SQL 标识符白名单：仅字母/数字/下划线，且以字母/下划线开头（SET ROLE 无法参数化） */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface OrgScopeOptions {
  /** 非超级用户应用角色（SET LOCAL ROLE）；传 null/空串则跳过 SET ROLE（连接本身即非 bypass 角色时用） */
  appRole?: string;
}

/**
 * 在绑定 org_id 的只读/读写事务内执行 fn。
 * fn 收到的 client 必须在该事务内使用，不得泄漏到事务外。
 */
export async function withOrgScope<T>(pool: Pool, orgId: string, fn: (client: PoolClient) => Promise<T>, opts: OrgScopeOptions = {}): Promise<T> {
  const appRole = opts.appRole ?? DEFAULT_APP_ROLE;
  const client = await pool.connect();
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
