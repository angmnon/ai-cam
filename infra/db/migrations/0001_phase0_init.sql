-- Phase 0 初始化（0001）：orgs / users / memberships / files / audit_logs / job_events / cam_jobs
-- 约定：所有业务表含 organization_id；时间戳 timestamptz；乐观锁 version；
-- 生产迁移由统一工具管理（Prisma/Drizzle/Flyway 选定后接入），本文件为权威 schema。

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,           -- org_xxx
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,           -- user_xxx
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  role            TEXT NOT NULL,            -- admin / engineer / operator / viewer
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE files (
  id            TEXT PRIMARY KEY,           -- file_xxx
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  resource_type TEXT NOT NULL,              -- CAD_SOURCE / CAD_PARSED / VIEW_MESH / ...
  resource_id   TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT 'v0',
  object_key    TEXT NOT NULL,              -- {org}/{type}/{resource}/{version}/{filename}
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    BIGINT NOT NULL,
  sha256        TEXT NOT NULL,
  storage       TEXT NOT NULL DEFAULT 'local',  -- local / r2
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, object_key)
);
CREATE INDEX idx_files_org_resource ON files(organization_id, resource_type, resource_id);

CREATE TABLE audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  organization_id TEXT,
  user_id         TEXT,
  action          TEXT NOT NULL,            -- job.create / job.transition / file.upload / auth.login ...
  resource_type   TEXT,
  resource_id     TEXT,
  request_id      TEXT,
  trace_id        TEXT,
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_time ON audit_logs(organization_id, created_at DESC);

CREATE TABLE cam_jobs (
  id               TEXT PRIMARY KEY,        -- job_xxx
  organization_id  TEXT NOT NULL REFERENCES organizations(id),
  project_id       TEXT,
  part_revision_id TEXT,
  machine_id       TEXT NOT NULL,
  controller_id    TEXT NOT NULL,
  material_id      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'DRAFT',
  version          BIGINT NOT NULL DEFAULT 0,   -- 乐观锁
  input_hash       TEXT,
  planner_version  TEXT,
  cam_engine_version TEXT,
  sim_version      TEXT,
  post_version     TEXT,
  failure          JSONB,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_org_status ON cam_jobs(organization_id, status, created_at DESC);

CREATE TABLE job_events (
  id              BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  job_id          TEXT NOT NULL REFERENCES cam_jobs(id),
  event_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,            -- job.progress / job.failed / ...
  source          TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  traceparent     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_events_job_time ON job_events(job_id, created_at);
