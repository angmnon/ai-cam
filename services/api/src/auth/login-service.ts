/**
 * P2-06：登录限流/锁定 + 密码重置编排服务。
 *
 * - 连续失败达 config.login.maxAttempts 次 → users.locked_until = now() + lockMinutes 分钟；
 *   锁定期内任何凭据（含正确密码）一律 429；登录成功清零（failed_login_count=0, locked_until=NULL）。
 * - 登录成功/失败/锁定均经 recordAudit（actor=email，outcome=ALLOWED/DENIED）。
 * - forgot-password：生成 32 字节随机 token，仅存 SHA-256 摘要（token_hash），1h 过期；
 *   v1 无邮件，原始 token 经审计日志 detail 回吐一次（运维带外下发）。
 * - reset-password：凭 token_hash 命中未用且未过期的令牌后，scrypt 派生新密码哈希并作废令牌。
 *
 * 零新运行依赖（node:crypto + pg + @ai-cam/security 既有 AuditSink）。
 */
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { recordAudit, type AuditSink } from "@ai-cam/security";
import type { AuthBackend, AuthedIdentity } from "./backends.js";
import { hashPassword } from "../plugins/credentials.js";

export interface LoginThrottleConfig {
  maxAttempts: number;
  lockMinutes: number;
}

export type LoginOutcome =
  | { status: "ok"; identity: AuthedIdentity }
  | { status: "invalid" }
  | { status: "locked"; retryAfterSec: number };

export class LoginService {
  constructor(
    private readonly pool: Pool | undefined,
    private readonly backend: AuthBackend,
    private readonly cfg: LoginThrottleConfig,
    private readonly auditSink: AuditSink,
  ) {}

  /** 审计写失败不阻塞主流程（登录可用 > 审计强一致；生产 PgAuditSink 正常路径不抛） */
  private async safeAudit(actor: string, role: string, action: string, resource: string, outcome: "ALLOWED" | "DENIED", detail?: string): Promise<void> {
    try {
      await recordAudit(this.auditSink, { actor, role, action, resource, detail }, outcome);
    } catch {
      /* 审计失败不影响登录响应 */
    }
  }

  async login(email: string, password: string): Promise<LoginOutcome> {
    const normEmail = email.trim().toLowerCase();

    // 内存降级路径（bootstrap 单账号，无 users 表持久化）：不做持久化限流，仅校验 + 审计
    if (!this.pool) {
      const identity = await this.backend.verify(email, password);
      if (identity) {
        await this.safeAudit(normEmail, identity.roles[0] ?? "ENGINEER", "auth.login", normEmail, "ALLOWED");
        return { status: "ok", identity };
      }
      await this.safeAudit(normEmail, "UNKNOWN", "auth.login", normEmail, "DENIED", "invalid credentials");
      return { status: "invalid" };
    }

    // PG 路径：先读失败计数/锁定状态
    const { rows } = await this.pool.query<{
      id: string;
      failed_login_count: number;
      locked_until: Date | null;
    }>(`SELECT id, failed_login_count, locked_until FROM users WHERE lower(email) = lower($1)`, [normEmail]);

    if (rows.length === 0) {
      await this.safeAudit(normEmail, "UNKNOWN", "auth.login", normEmail, "DENIED", "unknown user");
      return { status: "invalid" };
    }
    const user = rows[0];

    // 锁定期内：任何凭据一律拒绝（含正确密码）
    const now = Date.now();
    if (user.locked_until && user.locked_until.getTime() > now) {
      const retryAfterSec = Math.max(1, Math.ceil((user.locked_until.getTime() - now) / 1000));
      await this.safeAudit(normEmail, "USER", "auth.login", normEmail, "DENIED", `account locked until ${user.locked_until.toISOString()}`);
      return { status: "locked", retryAfterSec };
    }

    const identity = await this.backend.verify(email, password);
    if (!identity) {
      const newCount = user.failed_login_count + 1;
      const shouldLock = newCount >= this.cfg.maxAttempts;
      if (shouldLock) {
        // 达阈值：置锁定时刻；计数保留为 newCount，便于审计回溯
        await this.pool.query(
          `UPDATE users
              SET failed_login_count = $1,
                  locked_until       = now() + make_interval(mins => $2)
            WHERE id = $3`,
          [newCount, this.cfg.lockMinutes, user.id],
        );
      } else {
        await this.pool.query(`UPDATE users SET failed_login_count = $1 WHERE id = $2`, [newCount, user.id]);
      }
      await this.safeAudit(normEmail, "USER", "auth.login", normEmail, "DENIED", `bad password (fail #${newCount}${shouldLock ? ", locked" : ""})`);
      return { status: "invalid" };
    }

    // 成功：清零计数与锁定
    await this.pool.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await this.safeAudit(normEmail, identity.roles[0] ?? "USER", "auth.login", normEmail, "ALLOWED");
    return { status: "ok", identity };
  }

  /**
   * 发起密码重置：返回 void（统一对外 200，不泄漏邮箱是否存在）。
   * 存在该邮箱用户时生成一次性 token，仅存 SHA-256 摘要；原始 token 经审计 detail 回吐。
   */
  async forgotPassword(email: string): Promise<void> {
    if (!this.pool) return; // 内存路径无令牌表：静默 no-op
    const normEmail = email.trim().toLowerCase();
    const { rows } = await this.pool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [normEmail]);
    if (rows.length === 0) return;
    const user = rows[0];

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await this.pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [user.id, tokenHash],
    );
    // v1 无邮件：原始 token 仅在此处经审计日志落一次（运维带外下发）
    await this.safeAudit(normEmail, "USER", "auth.password_reset_request", normEmail, "ALLOWED", `reset_token=${rawToken}`);
  }

  /** 凭原始 token 重置密码；token 无效/过期/已用返回 false。成功时作废令牌并重置登录计数。 */
  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    if (!this.pool) return false;
    const tokenHash = createHash("sha256").update(token.trim()).digest("hex");
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
    if (rows.length === 0) return false;
    const userId = rows[0].user_id;
    const newHash = await hashPassword(newPassword);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1`, [tokenHash]);
      await client.query(
        `UPDATE users SET password_hash = $1, failed_login_count = 0, locked_until = NULL WHERE id = $2`,
        [newHash, userId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.safeAudit(userId, "USER", "auth.password_reset", userId, "ALLOWED");
    return true;
  }
}
