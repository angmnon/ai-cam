-- H-5 数据库回滚脚本模板
-- 用法：每个前向迁移（services/api/sql/00XX_*.sql）必须在此文件追加对应逆向段。
-- 执行顺序：先回滚 DB，再切换应用旧镜像。
-- 安全要求：执行前必须 pg_dump 全库备份。

-- ============================================================
-- 逆向段示例（按最新迁移倒序追加）：
-- ============================================================

-- 例：回滚 0005_create_job_release_table.sql
-- DROP TABLE IF EXISTS job_release;

-- 例：回滚 0004_add_cam_sim_report_columns.sql
-- ALTER TABLE jobs DROP COLUMN IF EXISTS sim_status;
-- ALTER TABLE jobs DROP COLUMN IF EXISTS nc_validator_status;

-- ============================================================
-- 完成检查
-- ============================================================
-- 执行后应确认：
-- 1) 版本表 schema_migrations 中对应版本已删除
-- 2) 应用与 DB 结构版本一致
SELECT 'ROLLBACK_READY' AS status;
