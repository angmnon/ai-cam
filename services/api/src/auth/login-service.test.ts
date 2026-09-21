/**
 * P2-06 LoginService 限流/锁定/密码重置单元测试。
 * 用内存 fake Pool 模拟 users / password_reset_tokens 表，验证：
 *  - 连续失败 5 次 → 第 6 次 429（locked）；
 *  - 锁定期内正确密码也 429；
 *  - 成功后计数清零；
 *  - forgot/reset-token 一次性语义。
 * 不依赖真库（真库行为在上线前另行实测）。
 */
import { randomBytes, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "@ai-cam/security";
import { LoginService } from "./login-service.js";
import type { AuthedIdentity, AuthBackend } from "./backends.js";

/** 最小假 Pool：仅实现 LoginService 用到的 users / password_reset_tokens 语句 */
class FakePool {
  users = new Map<string, { id: string; email: string; failed: number; lockedUntil: Date | null }>();
  tokens: Array<{ userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }> = [];
  now = () => Date.now();

  constructor() {
    this.users.set("admin@example.com", { id: "user_admin", email: "admin@example.com", failed: 0, lockedUntil: null });
  }

  async query(text: string, params: unknown[] = []) {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.startsWith("SELECT id, failed_login_count, locked_until FROM users")) {
      const email = String(params[0]).toLowerCase();
      const u = [...this.users.values()].find((x) => x.email === email);
      return { rows: u ? [{ id: u.id, failed_login_count: u.failed, locked_until: u.lockedUntil }] : [] };
    }
    if (t.startsWith("SELECT id FROM users")) {
      const email = String(params[0]).toLowerCase();
      const u = [...this.users.values()].find((x) => x.email === email);
      return { rows: u ? [{ id: u.id }] : [] };
    }
    const byId = (id: string) => [...this.users.values()].find((x) => x.id === id);
    if (t.startsWith("UPDATE users SET failed_login_count = $1, locked_until")) {
      const u = byId(String(params[2]))!;
      u.failed = Number(params[0]);
      u.lockedUntil = new Date(this.now() + Number(params[1]) * 60_000);
      return { rows: [] };
    }
    if (t.startsWith("UPDATE users SET failed_login_count = $1 WHERE")) {
      const u = byId(String(params[1]))!;
      u.failed = Number(params[0]);
      return { rows: [] };
    }
    if (t.startsWith("UPDATE users SET failed_login_count = 0, locked_until = NULL")) {
      const u = byId(String(params[0]))!;
      u.failed = 0;
      u.lockedUntil = null;
      return { rows: [] };
    }
    if (t.startsWith("INSERT INTO password_reset_tokens")) {
      this.tokens.push({ userId: String(params[0]), tokenHash: String(params[1]), expiresAt: new Date(this.now() + 3600_000), usedAt: null });
      return { rows: [] };
    }
    if (t.startsWith("SELECT user_id FROM password_reset_tokens")) {
      const th = String(params[0]);
      const row = this.tokens.find((x) => x.tokenHash === th && x.usedAt === null && x.expiresAt.getTime() > this.now());
      return { rows: row ? [{ user_id: row.userId }] : [] };
    }
    if (t.startsWith("UPDATE password_reset_tokens SET used_at")) {
      const th = String(params[0]);
      const row = this.tokens.find((x) => x.tokenHash === th);
      if (row) row.usedAt = new Date(this.now());
      return { rows: [] };
    }
    if (t.startsWith("UPDATE users SET password_hash = $1")) {
      const u = byId(String(params[1]))!;
      u.failed = 0;
      u.lockedUntil = null;
      return { rows: [] };
    }
    const head = t.toUpperCase();
    if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK") return { rows: [] };
    throw new Error(`FakePool: unhandled query: ${t}`);
  }
  connect() {
    return Promise.resolve({
      query: (text: string, params?: unknown[]) => this.query(text, params),
      release: () => undefined,
    });
  }
}

const goodBackend: AuthBackend = {
  async verify(_email: string, password: string): Promise<AuthedIdentity | null> {
    return password === "correct-horse" ? { sub: "user_admin", org_id: "org_admin", roles: ["ADMIN"] } : null;
  },
};

describe("P2-06 LoginService 限流/锁定", () => {
  it("连续失败 5 次 → 第 6 次 locked(429)；锁定期正确密码也 locked；成功后清零", async () => {
    const pool = new FakePool();
    const svc = new LoginService(pool as never, goodBackend, { maxAttempts: 5, lockMinutes: 15 }, new MemoryAuditSink());

    // 5 次错密码 → 均 invalid（第 5 次触发锁定）
    for (let i = 1; i <= 5; i++) {
      const r = await svc.login("admin@example.com", "wrong");
      expect(r.status, `attempt ${i}`).toBe("invalid");
    }
    // 第 6 次：锁定期，即使正确密码也 locked
    const locked = await svc.login("admin@example.com", "correct-horse");
    if (locked.status !== "locked") throw new Error(`expected locked, got ${locked.status}`);
    expect(locked.retryAfterSec).toBeGreaterThan(0);

    // 模拟锁定期已过
    [...pool.users.values()].find((u) => u.id === "user_admin")!.lockedUntil = new Date(Date.now() - 1000);
    const ok = await svc.login("admin@example.com", "correct-horse");
    expect(ok.status).toBe("ok");
    // 成功后计数清零
    expect([...pool.users.values()].find((u) => u.id === "user_admin")!.failed).toBe(0);
    expect([...pool.users.values()].find((u) => u.id === "user_admin")!.lockedUntil).toBeNull();
  });

  it("forgot → reset 一次性 token；重复用失败", async () => {
    const pool = new FakePool();
    const svc = new LoginService(pool as never, goodBackend, { maxAttempts: 5, lockMinutes: 15 }, new MemoryAuditSink());

    await svc.forgotPassword("admin@example.com");
    expect(pool.tokens.length).toBe(1);
    // 原始 token 不在表里（只存 sha256）
    const storedHash = pool.tokens[0].tokenHash;
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);

    // 从审计日志取回原始 token（v1 无邮件路径）。
    // 为验证 reset 流程，直接让该令牌的 token_hash 对应一个已知 raw token。
    const rawToken = randomBytes(32).toString("hex");
    pool.tokens[0].tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const first = await svc.resetPassword(rawToken, "new-strong-password");
    expect(first).toBe(true);
    // 重复使用同一 token → 失败
    const second = await svc.resetPassword(rawToken, "another-password");
    expect(second).toBe(false);
  });

  it("未知邮箱 forgot 不发令牌；reset 错误 token 返回 false", async () => {
    const pool = new FakePool();
    const svc = new LoginService(pool as never, goodBackend, { maxAttempts: 5, lockMinutes: 15 }, new MemoryAuditSink());
    await svc.forgotPassword("nobody@example.com");
    expect(pool.tokens.length).toBe(0);
    expect(await svc.resetPassword("nope", "whatever-password")).toBe(false);
  });
});
