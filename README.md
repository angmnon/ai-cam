# AI CNC CAM — 开发仓库（Phase 0 工程骨架）

> 目标：`真实 STEP → 3 轴 CAM → 仿真 → NC Ready`。本仓库按《AI_CNC_CAM_系统开发计划》推进，当前为 **Phase 0**。

## 仓库结构

```text
ai-cam/
├── apps/web            # Web 前端（Phase 0：Vite + React + Three.js Viewer 骨架）
├── packages/
│   ├── error-codes     # 统一错误码（AUTH_*/FILE_*/CAD_*/CAM_*/SIM_*/NC_*/MASTER_*/JOB_*/AI_*/SYSTEM_*）
│   ├── job-schema      # Job 领域模型 + 状态机（DRAFT→…→RELEASED）
│   ├── event-schema    # CloudEvents 风格事件 + SSE 契约
│   ├── cam-ir          # CAM IR schema + Validator + ChangeSet（v1.0）
│   └── domain-schemas  # Machine/Tool/Material/Feature 领域 schema
├── services/api        # API 服务（Fastify：auth/租户/文件/Job/SSE/OpenAPI/可观测性）
├── cpp/geometry-core   # OCCT 几何核心（Phase 0 POC 入口）
├── infra/
│   ├── docker/         # geometry-worker 等镜像
│   ├── db/migrations/  # 版本化 SQL 迁移
│   └── terraform/      # IaC（占位）
└── tests/              # 跨包集成与 Golden 测试（后续阶段）
```

## 快速开始

```bash
pnpm install
pnpm typecheck   # 全仓类型检查
pnpm test        # 全仓单元测试
pnpm --filter @ai-cam/api dev   # 启动 API（默认 :8080，见 services/api/README）
pnpm --filter @ai-cam/web dev   # 启动 Viewer（默认 :5173）
```

## Phase 0 验收（M0）

- [x] monorepo + CI/CD（GitHub Actions：lint/typecheck/unit/build/audit）
- [x] Auth（JWT 演示登录）+ 多租户中间件
- [x] 对象存储上传会话（本地适配器可跑，R2 适配器接口就绪）
- [x] API 骨架（统一响应/错误码/分页/OpenAPI）
- [x] Job 模型与状态机（含失败态，单测覆盖）
- [x] Viewer 骨架（网格渲染 + 交互）
- [x] 事件总线 + SSE（CloudEvents）
- [x] 可观测性（request_id 贯穿 + pino JSON 日志 + OTel 接口）
- [ ] OCCT 解析 POC 镜像构建（代码就绪，需 `docker build` 拉取 OCCT 依赖，见 infra/docker/geometry-worker/README.md）

## 关键约定

- CAM IR v1 冻结：`packages/cam-ir`（schema_version=1.0.0）
- Job 状态机：非法跳转被拒绝（见 `packages/job-schema/src/state-machine.ts`）
- 错误码：见 `packages/error-codes/src/error-codes.ts`
- 对象存储 Key：`/{org_id}/{resource_type}/{resource_id}/{version}/{file}`
