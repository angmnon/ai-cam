/**
 * P0-03：登录凭据校验后端抽象。
 * - BootstrapAuthBackend：无 DATABASE_URL 的内存降级路径（沿用 Phase 0 单账号 config）。
 * - PgAuthBackend：查 users 表（email → user → memberships 解算 org_id/role）。
 * 密码一律 node:crypto scrypt 恒定时间比对（plugins/credentials.ts），不引入 bcrypt。
 * 登录失败统一返回 null，由路由转 401，不回显具体失败点。
 */
import type { Pool } from "pg";
import type { BootstrapAuthConfig } from "../config.js";
import { verifyLoginPassword } from "../plugins/credentials.js";

export interface AuthedIdentity {
  sub: string;
  org_id: string;
  roles: string[];
}

export interface AuthBackend {
  /** 凭据正确返回身份（org/role 服务端解算）；任何失败返回 null */
  verify(email: string, password: string): Promise<AuthedIdentity | null>;
}

/** 内存降级路径：单 bootstrap 账号（demo@ai-cam.local / demo 或配置项） */
export class BootstrapAuthBackend implements AuthBackend {
  private readonly cfg: BootstrapAuthConfig;

  constructor(cfg: BootstrapAuthConfig) {
    this.cfg = cfg;
  }

  async verify(email: string, password: string): Promise<AuthedIdentity | null> {
    const emailOk = email.trim().toLowerCase() === this.cfg.email;
    const pwOk = await verifyLoginPassword(password, { password: this.cfg.password, hash: this.cfg.passwordHash });
    if (!emailOk || !pwOk) return null;
    return { sub: this.cfg.email, org_id: this.cfg.orgId, roles: [this.cfg.role] };
  }
}

/** PG 路径：users + memberships；不开放公开注册（v1 仅 bootstrap 管理端建用户） */
export class PgAuthBackend implements AuthBackend {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async verify(email: string, password: string): Promise<AuthedIdentity | null> {
    const { rows } = await this.pool.query<{
      id: string;
      email: string;
      password_hash: string | null;
      role: string | null;
      disabled_at: Date | null;
      organization_id: string | null;
      membership_role: string | null;
    }>(
      `SELECT u.id, u.email, u.password_hash, u.role, u.disabled_at,
              m.organization_id, m.role AS membership_role
         FROM users u
         LEFT JOIN memberships m ON m.user_id = u.id
        WHERE lower(u.email) = lower($1)`,
      [email.trim().toLowerCase()],
    );
    if (rows.length === 0) return null;
    const user = rows[0];
    if (user.disabled_at) return null;
    if (!user.password_hash || !user.password_hash.includes("$")) return null;
    const idx = user.password_hash.indexOf("$");
    const salt = user.password_hash.slice(0, idx);
    const hashHex = user.password_hash.slice(idx + 1).trim();
    const pwOk = await verifyLoginPassword(password, { hash: { salt, hashHex } });
    if (!pwOk) return null;

    const membership = rows.find((r) => r.organization_id) ?? null;
    if (!membership || !membership.organization_id) return null;
    // JWT 角色统一大写，对齐 RBAC Role 枚举
    const role = (membership.membership_role ?? user.role ?? "engineer").toUpperCase();
    return { sub: user.id, org_id: membership.organization_id, roles: [role] };
  }
}
