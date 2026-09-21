/**
 * P0-03：bootstrap 管理员首启播种（PG 模式）。
 * - 从 ADMIN_EMAIL/ADMIN_PASSWORD/ADMIN_ORG 环境变量读取（见 config.admin）。
 * - 幂等：org/user/membership 均 ON CONFLICT DO NOTHING / DO UPDATE，重复启动不重复建。
 * - 密码哈希沿用 node:crypto scrypt，格式 `salt$hashHex`（与 credentials.ts / 0006 一致）。
 * - 不开放公开注册：此处只建唯一的 ADMIN；v1 后续由管理端建用户。
 */
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

function toScryptHash(password: string, saltHex: string): Promise<string> {
  // 格式约定：salt$hashHex（与 credentials.ts / PgAuthBackend 的切分一致；KEYLEN=64 → hashHex 128 字符）
  return scryptAsync(password, saltHex, KEYLEN).then((derived) => `${saltHex}$${(derived as Buffer).toString("hex")}`);
}

export async function seedBootstrapAdmin(pool: Pool, config: AppConfig): Promise<void> {
  const { email, password, orgId } = config.admin;
  const orgName = "Default Organization";

  await pool.query(
    `INSERT INTO organizations (id, name, plan, status)
     VALUES ($1, $2, 'free', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [orgId, orgName],
  );

  const userId = `user_admin`;
  const salt = randomBytes(16).toString("hex");
  const passwordHash = await toScryptHash(password, salt);

  // 存在则更新密码哈希并强制 ADMIN、解除禁用；不存在则插入
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash, role)
     VALUES ($1, $2, 'Administrator', $3, 'ADMIN')
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = 'ADMIN',
           disabled_at = NULL
     RETURNING id`,
    [userId, email, passwordHash],
  );

  await pool.query(
    `INSERT INTO memberships (id, organization_id, user_id, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [`mem_${orgId}_admin`, orgId, userId],
  );
}
