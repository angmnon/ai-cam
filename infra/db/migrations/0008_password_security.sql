-- P2-06 密码体系完善：密码重置令牌 + 登录失败限流/锁定列
-- 依赖：0001~0007（users / memberships 已建；0001 已 CREATE EXTENSION pgcrypto → gen_random_uuid() 可用）
--
-- 约定：
--   * password_reset_tokens.token_hash 只存 token 的 SHA-256 摘要，不存原始 token；
--     原始 token 仅在 POST /auth/forgot-password 时经审计日志回吐一次（v1 无邮件）。
--   * expires_at 为过期时刻（forgot 时 = now() + 1h）；used_at 非空即视为已用，不可复用。
--   * users.failed_login_count / locked_until 由登录路径维护：
--     连续失败达 LOGIN_MAX_ATTEMPTS 次置 locked_until = now() + LOCK_MINUTES 分钟；
--     锁定期内任何凭据均 429；登录成功清零（failed_login_count=0, locked_until=NULL）。
-- 幂等：所有 DDL 均可重复执行（IF NOT EXISTS / IF EXISTS）。

-- ---- 密码重置令牌表 ----
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT PRIMARY KEY DEFAULT 'prt_' || replace(gen_random_uuid()::text, '-', ''),
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
-- 按用户吊销/查询全部未用令牌；按 token_hash 命中校验
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_unused ON password_reset_tokens(user_id) WHERE used_at IS NULL;

-- ---- 登录限流/锁定列 ----
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until       TIMESTAMPTZ;
