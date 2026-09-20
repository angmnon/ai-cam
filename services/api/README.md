# @ai-cam/api — API 服务骨架（Phase 0）

Fastify 5 实现：auth / 租户 / 文件上传会话 / Job 状态机 / SSE 事件 / OpenAPI / 可观测性。

## 启动

```bash
cp .env.example ../../.env.local   # 或设置环境变量
pnpm --filter @ai-cam/api dev      # http://localhost:8080
```

- OpenAPI 文档：`http://localhost:8080/docs`
- 健康检查：`GET /health`

## 演示流程（curl）

```bash
# 1) 登录（Phase 0 演示：任意邮箱）
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"eng@test.local","password":"x","organization_id":"org_demo"}' | jq -r .data.token)

# 2) 创建 Job
curl -s -X POST http://localhost:8080/api/v1/jobs -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"input":{"part_id":"part_1","machine_id":"m_vmc_3axis","controller_id":"c_fanuc","material_id":"mat_6061"}}'

# 3) 订阅事件（SSE）
curl -N "http://localhost:8080/api/v1/events/stream?subject=job_xxx" -H "authorization: Bearer $TOKEN"
```

## 路由清单（Phase 0）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /health | 健康检查 |
| POST | /api/v1/auth/login | 演示登录（返回 JWT） |
| POST | /api/v1/jobs | 创建 Job（支持 Idempotency-Key） |
| GET | /api/v1/jobs | Job 列表（page/page_size/status） |
| GET | /api/v1/jobs/:id | Job 详情 |
| POST | /api/v1/jobs/:id/transition | 状态迁移（状态机门禁） |
| POST | /api/v1/jobs/:id/fail | 失败上报（→ FAILED + job.failed） |
| POST | /api/v1/files/upload-sessions | 创建上传会话（local 适配器） |
| POST | /api/v1/files/upload | 本地适配器实际上传（octet-stream） |
| GET | /api/v1/events/stream | SSE 事件流（?subject=job_xxx） |

## 关键实现

- 统一错误体：`packages/error-codes`（error.code/stage/details/retryable/request_id）
- Job 状态机：`packages/job-schema`（非法跳转 → 409 JOB_STATE_INVALID）
- 事件：CloudEvents 风格（`packages/event-schema`），内存总线可替换为 Queues/Redis
- 存储：`StorageAdapter` 接口 + 本地磁盘适配器（可跑）+ R2 适配器（就绪未接 presign）
- 可观测性：request_id 贯穿（X-Request-Id）、traceparent 下发、pino JSON 日志、OTel noop tracer

## 测试

```bash
pnpm --filter @ai-cam/api test
```
