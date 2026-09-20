-- Phase 1：零件解析流水线 + 主数据表结构
-- 依赖：0001_phase0_init.sql（orgs/users 等已建）

-- 零件（CAD 上传 → 解析 → 特征/DFM）
CREATE TABLE IF NOT EXISTS parts (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES orgs(id),
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL DEFAULT 'model/step',
  size_bytes      BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','PARSING','ANALYZED','FAILED')),
  source_key      TEXT NOT NULL,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_parts_org ON parts(organization_id, created_at DESC);

-- 分析结果（规范化几何模型 / MFG 特征图 / DFM 报告，v1 存 JSONB）
CREATE TABLE IF NOT EXISTS part_analysis (
  part_id       TEXT PRIMARY KEY REFERENCES parts(id) ON DELETE CASCADE,
  part_json     JSONB NOT NULL,
  feature_graph JSONB NOT NULL,
  dfm_report    JSONB NOT NULL,
  mesh_key      TEXT,
  recognizer_version TEXT,
  analyzed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 特征明细（便于 SQL 查询/过滤，JSONB 冗余 feature_graph）
CREATE TABLE IF NOT EXISTS part_features (
  id              TEXT NOT NULL,
  part_id         TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  feature_type    TEXT NOT NULL,
  confidence      NUMERIC(4,3) NOT NULL,
  bbox_min        NUMERIC[] NOT NULL,
  bbox_max        NUMERIC[] NOT NULL,
  accessible_directions TEXT[] NOT NULL DEFAULT '{}',
  dimensions      JSONB,
  PRIMARY KEY (part_id, id)
);
CREATE INDEX IF NOT EXISTS idx_part_features_type ON part_features(feature_type);

-- 主数据（Phase 1 以 JSONB 存储，PK = resource + id + org；API 提供种子数据）
CREATE TABLE IF NOT EXISTS master_entities (
  resource        TEXT NOT NULL, -- machine / controller / tool / material / cutting_rule
  id              TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES orgs(id),
  data            JSONB NOT NULL,
  version         INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (resource, id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_master_entities_org ON master_entities(organization_id, resource);
