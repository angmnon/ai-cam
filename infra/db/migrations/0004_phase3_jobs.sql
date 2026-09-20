-- Phase 3：Job 端到端（job_runs / nc_programs / validation_reports）
-- 依赖：0001_phase0_init.sql（orgs）、0002_phase1_parts.sql（parts）、0003_phase2_cam.sql（cam_revisions）

-- Job 运行记录：一次 plan→sim→post→validate 全流程
CREATE TABLE IF NOT EXISTS job_runs (
  id             TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES orgs(id),
  part_id        TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  cam_revision_id TEXT REFERENCES cam_revisions(id),
  status         TEXT NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('RUNNING','PASS','WARN','FAIL')),
  pipeline       JSONB NOT NULL DEFAULT '[]',
  engine_version TEXT NOT NULL,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NC 程序产物（每个 Job 可含多个控制器方言）
CREATE TABLE IF NOT EXISTS nc_programs (
  id             TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES orgs(id),
  part_id        TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  job_run_id     TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  program_number TEXT NOT NULL,
  dialect        TEXT NOT NULL,
  controller_id  TEXT,
  nc_text        TEXT NOT NULL,
  line_count     INT NOT NULL,
  move_count     INT NOT NULL,
  tool_changes   INT NOT NULL,
  engine_version TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nc_programs_job ON nc_programs(job_run_id);
CREATE INDEX IF NOT EXISTS idx_nc_programs_part ON nc_programs(part_id);

-- 校验报告产物（四层分层报告 JSON）
CREATE TABLE IF NOT EXISTS validation_reports (
  id             TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES orgs(id),
  part_id        TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  job_run_id     TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  nc_program_id  TEXT REFERENCES nc_programs(id),
  status         TEXT NOT NULL CHECK (status IN ('PASS','WARN','FAIL')),
  layers         JSONB NOT NULL DEFAULT '[]',
  report         JSONB NOT NULL,
  validator_version TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_validation_reports_job ON validation_reports(job_run_id);
