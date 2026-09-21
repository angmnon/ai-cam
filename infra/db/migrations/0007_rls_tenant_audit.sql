-- P1-07 多租户行级安全（RLS）+ P1-08 审计持久化表
-- 依赖：0001~0006（所有业务表已建）。
--
-- 设计：
--   * 业务表（除 organizations/users/memberships 身份表）ENABLE + FORCE RLS；
--     FORCE 使表 owner 也受 RLS 约束。
--   * 策略：organization_id = current_setting('app.org_id', true)::text；
--     app.org_id 未设置（NULL）时比较为 NULL → 一行不可见（默认拒绝）。
--   * 无 organization_id 的子表（part_analysis/part_features/stocks/setups/operations/
--     operation_parameters/toolpaths/release_approvals）经父表 EXISTS 判定归属。
--   * 应用连接角色为 superuser（会绕过 RLS），故新建 NOBYPASSRLS 角色 aicam_app，
--     应用在 withOrgScope 内 SET LOCAL ROLE aicam_app 后真正生效（见 db/org-scope.ts）。
--
-- 幂等：所有 ENABLE/FORCE/POLICY/GRANT 均可重复执行（DROP POLICY IF EXISTS）。

-- ---- P1-08：审计持久化表（0001 已有 audit_logs，此处补 PgAuditSink 所用列与索引）----
-- 0001.audit_logs 列：id BIGSERIAL / organization_id TEXT NULL / user_id / action /
--   resource_type / resource_id / request_id / trace_id / details JSONB / created_at
-- 为对齐 PgAuditSink 接口（actor/action/resource/outcome/payload），补列并兼容旧列。
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor    TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS outcome  TEXT NOT NULL DEFAULT 'ALLOWED';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS payload  JSONB NOT NULL DEFAULT '{}';
-- 兼容旧 details 列：payload 写入时回填 details，读侧统一读 payload
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_logs(actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_outcome ON audit_logs(organization_id, outcome, created_at DESC);

-- ---- P1-07：应用专属非超级用户（NOBYPASSRLS）----
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aicam_app') THEN
    CREATE ROLE aicam_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aicam_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aicam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aicam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aicam_app;

-- ============ 有 organization_id 的业务表：直接策略 ============
DO $$
DECLARE
  t text;
  org_tables text[] := ARRAY[
    'files','cam_jobs','job_events',
    'parts','master_entities',
    'cam_revisions','job_runs','nc_programs','validation_reports','releases'
  ];
BEGIN
  FOREACH t IN ARRAY org_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY org_isolation ON %I
      FOR ALL
      USING (organization_id = current_setting('app.org_id', true)::text)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::text)
    $f$, t);
  END LOOP;
END
$$;

-- ============ 无 organization_id 的子表：经父表 EXISTS 归属 ============
-- part_analysis / part_features → parts
ALTER TABLE part_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_analysis FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON part_analysis;
CREATE POLICY org_isolation ON part_analysis
  FOR ALL
  USING (EXISTS (SELECT 1 FROM parts p WHERE p.id = part_analysis.part_id AND p.organization_id = current_setting('app.org_id', true)::text))
  WITH CHECK (EXISTS (SELECT 1 FROM parts p WHERE p.id = part_analysis.part_id AND p.organization_id = current_setting('app.org_id', true)::text));

ALTER TABLE part_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_features FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON part_features;
CREATE POLICY org_isolation ON part_features
  FOR ALL
  USING (EXISTS (SELECT 1 FROM parts p WHERE p.id = part_features.part_id AND p.organization_id = current_setting('app.org_id', true)::text))
  WITH CHECK (EXISTS (SELECT 1 FROM parts p WHERE p.id = part_features.part_id AND p.organization_id = current_setting('app.org_id', true)::text));

-- stocks / setups / operations / operation_parameters / toolpaths → cam_revisions
DO $$
DECLARE
  t text;
  child text[] := ARRAY['stocks','setups','operations','operation_parameters','toolpaths'];
BEGIN
  FOREACH t IN ARRAY child LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY org_isolation ON %I
      FOR ALL
      USING (EXISTS (SELECT 1 FROM cam_revisions c WHERE c.id = %I.cam_revision_id AND c.organization_id = current_setting('app.org_id', true)::text))
      WITH CHECK (EXISTS (SELECT 1 FROM cam_revisions c WHERE c.id = %I.cam_revision_id AND c.organization_id = current_setting('app.org_id', true)::text))
    $f$, t, t, t);
  END LOOP;
END
$$;

-- release_approvals → releases
ALTER TABLE release_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON release_approvals;
CREATE POLICY org_isolation ON release_approvals
  FOR ALL
  USING (EXISTS (SELECT 1 FROM releases r WHERE r.id = release_approvals.release_id AND r.organization_id = current_setting('app.org_id', true)::text))
  WITH CHECK (EXISTS (SELECT 1 FROM releases r WHERE r.id = release_approvals.release_id AND r.organization_id = current_setting('app.org_id', true)::text));

-- ============ audit_logs：org 隔离 + 全局行（organization_id IS NULL）可读 ============
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON audit_logs;
CREATE POLICY org_isolation ON audit_logs
  FOR ALL
  USING (organization_id = current_setting('app.org_id', true)::text OR organization_id IS NULL)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::text OR organization_id IS NULL);

-- 注：organizations / users / memberships 为身份与组织维度表，跨 org 按设计共享（登录/成员解析），
-- 不纳入 RLS（任务明确 organizations 除外）。
