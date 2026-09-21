-- Phase P0-03：多用户认证（users 扩列 + memberships 索引）
-- 依赖：0001_phase0_init.sql（已建 organizations/users/memberships，含 memberships UNIQUE(organization_id,user_id)）
-- 约定：
--   * users.password_hash 沿用 node:crypto scrypt，格式 `salt$hashHex`（salt 为随机 hex，hashHex 为派生摘要 hex）；
--     与 services/api/src/plugins/credentials.ts 的 verifyLoginPassword 完全一致，禁止引入 bcrypt 等新哈希依赖。
--   * bootstrap 管理员不写死在 SQL：由服务首启代码从 ADMIN_EMAIL/ADMIN_PASSWORD 环境变量播种
--     （见 services/api/src/db/bootstrap.ts），保证多环境可配。
--   * memberships(organization_id, user_id) 唯一约束已在 0001 建立，此处仅补登录查询索引。

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'ENGINEER';
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- 登录按邮箱（大小写不敏感）解算用户 → memberships 解算 org_id/role
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
-- memberships 反查某组织全部成员（管理端建用户/列成员时用）
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships (organization_id);

-- P0-01：job_runs 仿真报告 JSONB（迁移 0004 未单列，此处补齐，不改 0001~0005 权威 schema）
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS simulation_json JSONB;
