-- H-5 数据库回滚脚本模板
-- 用法：每个前向迁移（infra/db/migrations/00XX_*.sql）必须在此文件追加对应逆向段。
-- 执行顺序：先回滚 DB，再切换应用旧镜像；按迁移号逆序（0005 → 0001）DROP，先子后父。
-- 安全要求：执行前必须 pg_dump 全库备份。

-- ============================================================
-- 逆向段（按最新迁移倒序追加；外键先删依赖表）
-- ============================================================

-- ---- 回滚 0005_phase4_releases.sql ----
DROP TABLE IF EXISTS release_approvals;
DROP TABLE IF EXISTS releases;

-- ---- 回滚 0004_phase3_jobs.sql ----
DROP TABLE IF EXISTS validation_reports;
DROP TABLE IF EXISTS nc_programs;
DROP TABLE IF EXISTS job_runs;

-- ---- 回滚 0003_phase2_cam.sql ----
DROP TABLE IF EXISTS toolpaths;
DROP TABLE IF EXISTS operation_parameters;
DROP TABLE IF EXISTS operations;
DROP TABLE IF EXISTS setups;
DROP TABLE IF EXISTS stocks;
DROP TABLE IF EXISTS cam_revisions;

-- ---- 回滚 0002_phase1_parts.sql ----
DROP TABLE IF EXISTS master_entities;
DROP TABLE IF EXISTS part_features;
DROP TABLE IF EXISTS part_analysis;
DROP TABLE IF EXISTS parts;

-- ---- 回滚 0001_phase0_init.sql ----
DROP TABLE IF EXISTS job_events;
DROP TABLE IF EXISTS cam_jobs;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organizations;

-- ============================================================
-- 完成检查
-- ============================================================
-- 执行后应确认：
-- 1) 版本表 schema_migrations 中对应版本已删除
-- 2) 应用与 DB 结构版本一致
SELECT 'ROLLBACK_READY' AS status;
