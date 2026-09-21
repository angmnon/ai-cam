-- Phase 4：Release 工作流（P4-11：审批链 / 自动释放规则 / 版本链 / 二维码）
-- 依赖：0002_phase1_parts.sql（parts）、0003_phase2_cam.sql（cam_revisions）、0004_phase3_jobs.sql（job_runs）

-- Release：零件的可追溯发布记录（每零件一版本链，version_no 递增）
CREATE TABLE IF NOT EXISTS releases (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  part_id         TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  cam_revision_id TEXT NOT NULL REFERENCES cam_revisions(id),
  job_run_id      TEXT NOT NULL REFERENCES job_runs(id),
  version_no      INT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                    CHECK (status IN ('PENDING_APPROVAL','APPROVED','RELEASED','REJECTED')),
  requested_by    TEXT NOT NULL,
  approved_by     TEXT,
  approval_note   TEXT,
  qr_token        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at     TIMESTAMPTZ,
  released_at     TIMESTAMPTZ,
  UNIQUE (part_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_releases_part ON releases(part_id, version_no);
CREATE INDEX IF NOT EXISTS idx_releases_org ON releases(organization_id);

-- 审批记录（审批链审计：单级审批 v1，为多级扩展预留）
CREATE TABLE IF NOT EXISTS release_approvals (
  id          TEXT PRIMARY KEY,
  release_id  TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  approver_id TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('APPROVE','REJECT')),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_release_approvals_rel ON release_approvals(release_id);
