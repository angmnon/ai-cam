# infra/terraform — AI CNC CAM 基础设施即代码（骨架）

> ⚠️ **本目录为 P2-03 骨架占位，未在任何真实云账号上执行过 `terraform plan` / `terraform apply`。**
> 代码仅作 HCL 语法正确的结构示意；上线前必须按下方"落地清单"补齐。

## 目录内容

| 文件 | 作用 |
| --- | --- |
| `main.tf` | 三类占位资源块：PostgreSQL、Cloudflare R2 对象存储、容器服务（API + Web 静态） |
| `variables.tf` | 变量声明（全部带占位默认值，便于无云账号环境 `terraform validate` 通过） |
| `outputs.tf` | 输出声明（骨架阶段仅渲染模板文件路径） |

当前实现用 `local_file` 渲染三份 `.out/*.env` 模板，**不真实创建任何云资源**，避免在无凭据环境下拉取 provider 失败。

## 覆盖组件（与 services/api 现有集成点对齐）

1. **PostgreSQL** —— 对应 `DATABASE_URL`；承载 `users/memberships/jobs/parts/releases` 持久层（`services/api/src/db/pg/*`）。
2. **Cloudflare R2** —— 对应 `STORAGE_DRIVER=r2`；承载 STEP 源文件 / 解析 mesh / NC 产物（`services/api/src/storage/r2-adapter.ts`）。
3. **容器服务** —— Fastify API（`services/api`，监听 8080）+ Vite 静态前端（`apps/web/dist`）。

## 与 P2-02 cookie 配套的约束

- `CORS_ORIGINS` 必须是**精确白名单**（不能 `*`），且后端需 `credentials: true`，否则浏览器拒绝携带 `aicam_session` HttpOnly cookie。
- 生产部署必须 `NODE_ENV=production`，登录下发 cookie 才会带 `Secure` 属性（仅 HTTPS 下发）。

## 落地清单（上线前必须完成）

1. 打开 `main.tf` 中 `required_providers` 注释，锁定 provider 版本。
2. 注入真实凭据（Cloudflare API token / R2 access key / 托管 Postgres DSN）——**走 secret 管理，禁止入库**。
3. `terraform init` → `terraform plan` → 人工 review → `terraform apply`。
4. 把 apply 输出的真实 DSN / R2 bucket / service URL 回填到容器服务环境变量。
5. 跑 `e2e/happy-path.spec.ts` 冒烟，确认 cookie 在真实域名下仍正常工作。

## 不在本骨架范围

- 未引入 terraform 可执行文件（按任务要求，CI/本地自行安装）。
- 未做网络/VPC/可观测性/告警资源 —— 上线前按云厂商最佳实践补齐。
