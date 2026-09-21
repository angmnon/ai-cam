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

## 架构备注：事件总线分布式化路径（P2-04）

> **状态：暂缓 — 非必需（暂缓-非必需）。** 单实例进程内事件总线已能覆盖当前 Phase 0–2 的全部 SSE/审计/指标需求；以下路径仅在需要多副本水平扩容、跨进程 Job 通知或跨服务事件分发时再启动。

- **现状**：`services/api/src/bus/event-bus.ts` 为进程内 `InMemoryEventBus`，`subscribe / publish` 仅在本 Node 进程内生效。SSE（`/api/v1/events/stream`）的订阅方与事件生产方必须在同一进程。
- **未来分布式化路径（任选其一或组合，按负载选型）**：
  1. **Redis Pub/Sub**：替换 `InMemoryEventBus`，所有 API 副本订阅同一 channel，事件 fan-out 到本进程内的 SSE 订阅者。适合低延迟、at-most-once、无持久化要求的实时通知。
  2. **PostgreSQL `LISTEN/NOTIFY`**：复用现有 `DATABASE_URL`，按 `org_id` / `job_*` 分 channel 订阅。零新基础设施，但受 PG 单连接限制、消息不持久化、不适合高频事件。
  3. **需要持久化 / 严格投递语义时**：再引入 Kafka / NATS / Cloudflare Queues（与 Phase 4 之后的异步 Job 队列合并设计）。
- **迁移前置条件**：① `EventBus` 接口已稳定（`publish(subject, event)` + `subscribe(handler)`），实现可替换；② SSE 路由的 subject 校验已存在（仅允许 `job_*`）；③ 多副本后需考虑 sticky session / 跨副本订阅路由。
- **不启动的理由**：当前部署形态为单 API 进程 + 内存/PG 持久层；水平扩容未提上日程，过早引入 Redis 会增加运维成本与故障面。
