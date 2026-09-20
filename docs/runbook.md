# AI-CNC-CAM 生产 Runbook（H-5）

> 版本：v1.0（Phase 6 / H-5）· 适用环境：生产部署（docker-compose + 对象存储 + Postgres）
> 目标：**发布可控、回滚可逆、故障可恢复**（RPO ≤ 15min，RTO ≤ 2h）

## 1. 发布流程（标准变更）

| 步骤 | 动作 | 命令 / 说明 |
| --- | --- | --- |
| 1 | 代码冻结与全仓回归 | `pnpm -r run build && pnpm -r run test` 全绿 |
| 2 | Golden 全量回归 | `pnpm --filter @ai-cam/regression run regression` ≥ 300/300 |
| 3 | 工厂验证批跑 | `pnpm --filter @ai-cam/factory-validation run factory-check` 无 FAIL |
| 4 | 打版本与提交 | `git tag vX.Y.Z` 后 push（含 lockfile 与迁移脚本） |
| 5 | 数据库迁移（前向） | `psql $DATABASE_URL -f services/api/sql/00XX_*.sql`（按序执行） |
| 6 | 蓝绿发布 | 先起新容器组 → 健康检查通过 → 切流量 → 观察 30min |
| 7 | 回滚预案就绪 | 保留旧镜像标签 + 本次迁移 SQL 的逆向脚本（见 §2） |

> 变更窗口建议工作时段执行；任何一步失败立即回到"上次健康版本"并触发 §3 复盘。

## 2. 回滚流程

### 2.1 应用回滚（≤ 10min）

```bash
# 切回旧镜像（docker-compose 指定 tag）
docker compose down
export APP_IMAGE=registry.local/ai-cam/app:vPREV
docker compose up -d
# 验证
curl -sf http://localhost:8080/healthz
```

### 2.2 数据库回滚（≤ 30min，仅在迁移已执行且需逆向时）

- 每个前向迁移必须携带逆向脚本：`scripts/db-rollback.sql`（按最新迁移追加 `ROLLBACK` 段）。
- 执行顺序：**先回滚 DB → 再切应用旧镜像**（避免新代码读旧结构）。
- 逆向前必须 `pg_dump` 全库备份（`scripts/db-backup.ps1` 模板见仓库）。

```bash
psql $DATABASE_URL -f scripts/db-rollback.sql   # 仅含本次待回滚迁移的逆向段
```

### 2.3 数据恢复（RPO ≤ 15min）

- 每日全量备份 00:00（对象存储，保留 7 天）+ 每 15min WAL 归档。
- 恢复演练：`docs/dr-exercise.md` 记录 2026-09 演练结果。

## 3. 故障响应（SEV 分级）

| SEV | 定义 | 响应时限 | 首要动作 |
| --- | --- | --- | --- |
| SEV-1 | 核心 API 不可用 / 数据丢失风险 | 15min | 回滚到上一健康版本；必要时停写保护数据 |
| SEV-2 | 任务 p95 超 SLO / 单模块失败 | 2h | 定位热点（见 §4 性能兜底），必要时降级开关 |
| SEV-3 | 非核心功能缺陷 | 下个发布窗口 | 记录缺陷，随下个版本修复 |

## 4. 性能 SLO 与兜底（H-4）

| 指标 | 目标 | 监控点 |
| --- | --- | --- |
| 零件解析 API | 99.9% ≤ 5s | `/api/v1/parts/analyze` 分位数 |
| CAM 任务生成 | p95 ≤ 2s（300 特征以内） | job-runner 任务时长 |
| 仿真（体素） | p95 ≤ 3s（自动分辨率） | `stock-sim autoVoxelSize` |

兜底：仿真分辨率自动降档（大零件 5mm）、任务队列背压、重复请求幂等。

## 5. 灾备（DR）

- 异地对象存储副本（每日 1 次）+ WAL 归档 15min 间隔（RPO ≤ 15min）。
- 恢复目标 RTO ≤ 2h：镜像在私有仓库、DB 备份可一键 `pg_restore`。
- 每季度一次 DR 演练，结果记录到 `docs/dr-exercise.md`。
