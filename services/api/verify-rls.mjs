/**
 * P1-07/P1-08 真库 RLS + 审计 sink 验证（一次性手动验证脚本）。
 * 运行：DATABASE_URL=postgres://aicam:aicam_dev@localhost:5432/aicam node dist/verify-rls.mjs
 * 验证：
 *   1) superuser 写 orgA 一条 part；
 *   2) withOrgScope(orgB) 查 parts → 0 行（RLS 隔离）；
 *   3) withOrgScope(orgB) 跨 org UPDATE → 0 行命中；
 *   4) withOrgScope(orgA) 查 parts → 1 行（本租户可见）；
 *   5) PgAuditSink append + queryAudit 读回。
 */
import { Pool } from "pg";
import { withOrgScope } from "./dist/db/org-scope.js";
import { PgAuditSink } from "./dist/db/pg/pg-audit-sink.js";

const url = process.env.DATABASE_URL ?? "postgres://aicam:aicam_dev@localhost:5432/aicam";
const pool = new Pool({ connectionString: url });
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}  ${detail ?? ""}`);
}

try {
  // 0) 确保两个 org 存在（superuser 不受 RLS）
  await pool.query(`INSERT INTO organizations (id,name,plan,status) VALUES ('org_a','Org A','free','ACTIVE') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO organizations (id,name,plan,status) VALUES ('org_b','Org B','free','ACTIVE') ON CONFLICT (id) DO NOTHING`);

  // 清理可能的旧验证数据
  await pool.query(`DELETE FROM parts WHERE organization_id IN ('org_a','org_b') AND id LIKE 'part_rlstest_%'`);

  // 1) superuser 写 orgA 一条 part（绕过 RLS）
  await pool.query(
    `INSERT INTO parts (id, organization_id, filename, content_type, size_bytes, status, source_key, created_by)
     VALUES ('part_rlstest_a1','org_a','a.step','model/step',1024,'ANALYZED','k','t')`,
  );

  // 2) orgB 会话查 parts → 应 0 行
  const bCount = await withOrgScope(pool, "org_b", async (c) => (await c.query(`SELECT count(*)::int AS n FROM parts WHERE id='part_rlstest_a1'`)).rows[0].n);
  check("orgB 查 orgA part → 0 行", bCount === 0, `count=${bCount}`);

  // 3) orgB 会话跨 org UPDATE → 0 行命中
  const upd = await withOrgScope(pool, "org_b", async (c) => (await c.query(`UPDATE parts SET status='FAILED' WHERE id='part_rlstest_a1' RETURNING id`)).rowCount);
  check("orgB 跨 org UPDATE → 0 行", upd === 0, `rowCount=${upd}`);

  // orgA 自己仍可见且未被改
  const aSees = await withOrgScope(pool, "org_a", async (c) => (await c.query(`SELECT status FROM parts WHERE id='part_rlstest_a1'`)).rows[0]);
  check("orgA 见本租户 part 且未被跨 org 改动", aSees && aSees.status === "ANALYZED", `status=${aSees?.status}`);

  // 4) orgA 查 → 1 行
  const aCount = await withOrgScope(pool, "org_a", async (c) => (await c.query(`SELECT count(*)::int AS n FROM parts WHERE id='part_rlstest_a1'`)).rows[0].n);
  check("orgA 查本租户 part → 1 行", aCount === 1, `count=${aCount}`);

  // 5) PgAuditSink append + queryAudit
  const sink = new PgAuditSink(pool);
  await sink.append({ id: "evt_rlstest_1", ts: new Date().toISOString(), actor: "verify@org_a", role: "ADMIN", action: "rbac", resource: "/verify", outcome: "ALLOWED" });
  const rows = await sink.queryAudit({ actor: "verify@org_a", action: "rbac" });
  check("PgAuditSink append + queryAudit 读回 ≥1", rows.length >= 1, `rows=${rows.length}; first.action=${rows[0]?.action}`);

  // 清理验证数据
  await pool.query(`DELETE FROM parts WHERE id='part_rlstest_a1'`);
  await pool.query(`DELETE FROM audit_logs WHERE actor='verify@org_a'`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[verify-rls] 汇总: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error("[verify-rls] 失败:", e);
  process.exit(1);
} finally {
  await pool.end();
}
