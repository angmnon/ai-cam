-- Phase 2：CAM 内核（cam_revisions / stocks / setups / operations / operation_parameters / toolpaths）
-- 依赖：0001_phase0_init.sql（orgs）、0002_phase1_parts.sql（parts）

-- CAM 修订版（一次工艺规划 = 一个 revision；每次 POST toolpath 生成新 revision）
CREATE TABLE IF NOT EXISTS cam_revisions (
  id           TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  part_id      TEXT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  revision_no  INT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'READY'
                 CHECK (status IN ('READY','FAILED')),
  engine_version TEXT NOT NULL,
  cam_ir_json  JSONB NOT NULL,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (part_id, revision_no)
);
CREATE INDEX IF NOT EXISTS idx_cam_revisions_org ON cam_revisions(organization_id, part_id, created_at DESC);

-- 毛坯（CAM IR stock 明细）
CREATE TABLE IF NOT EXISTS stocks (
  id            TEXT NOT NULL,
  cam_revision_id TEXT NOT NULL REFERENCES cam_revisions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  dims          NUMERIC[] NOT NULL,       -- [x, y, z]
  origin        NUMERIC[] NOT NULL,       -- [x, y, z]
  margin        NUMERIC[] NOT NULL,
  PRIMARY KEY (cam_revision_id, id)
);

-- 坐标系（CAM IR setups 明细）
CREATE TABLE IF NOT EXISTS setups (
  id            TEXT NOT NULL,
  cam_revision_id TEXT NOT NULL REFERENCES cam_revisions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  wcs           TEXT NOT NULL,
  origin        NUMERIC[] NOT NULL,
  PRIMARY KEY (cam_revision_id, id)
);

-- 工序（operations 明细）
CREATE TABLE IF NOT EXISTS operations (
  id            TEXT NOT NULL,
  cam_revision_id TEXT NOT NULL REFERENCES cam_revisions(id) ON DELETE CASCADE,
  op_index      INT NOT NULL,
  name          TEXT NOT NULL,
  op_type       TEXT NOT NULL,
  setup_id      TEXT NOT NULL,
  tool_id       TEXT NOT NULL,
  tool_number   INT NOT NULL,
  feature_ids   TEXT[] NOT NULL DEFAULT '{}',
  depends_on    TEXT[] NOT NULL DEFAULT '{}',
  safe_z_mm     NUMERIC,
  tolerance_mm  NUMERIC,
  PRIMARY KEY (cam_revision_id, id)
);
CREATE INDEX IF NOT EXISTS idx_operations_type ON operations(op_type);

-- 工序参数（operation_parameters 明细，v1 存 JSONB）
CREATE TABLE IF NOT EXISTS operation_parameters (
  operation_id  TEXT NOT NULL,
  cam_revision_id TEXT NOT NULL REFERENCES cam_revisions(id) ON DELETE CASCADE,
  params_json   JSONB NOT NULL,
  source        TEXT NOT NULL,
  PRIMARY KEY (cam_revision_id, operation_id)
);

-- 刀路（toolpaths 明细，move 列表 JSONB + 统计）
CREATE TABLE IF NOT EXISTS toolpaths (
  id            TEXT NOT NULL,
  cam_revision_id TEXT NOT NULL REFERENCES cam_revisions(id) ON DELETE CASCADE,
  operation_id  TEXT NOT NULL,
  move_count    INT NOT NULL,
  bounds        JSONB NOT NULL,           -- {min:{x,y,z},max:{x,y,z}}
  moves_json    JSONB NOT NULL,
  engine_version TEXT NOT NULL,
  PRIMARY KEY (cam_revision_id, id)
);
CREATE INDEX IF NOT EXISTS idx_toolpaths_op ON toolpaths(cam_revision_id, operation_id);
