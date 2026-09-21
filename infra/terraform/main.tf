# =============================================================================
# AI CNC CAM — IaC 骨架（P2-03）
# -----------------------------------------------------------------------------
# ⚠️ 警告：本目录为**骨架占位**，未在任何真实云账号上执行过 `terraform plan` / `apply`。
#   - 未配置 provider 凭据，未锁定 provider 版本（避免在无云账号环境下拉取 provider 失败）。
#   - 资源块仅描述最终形态（Postgres / R2 对象存储 / 容器服务），HCL 语法正确即可。
#   - 上线前需：① 填入真实 provider 凭据；② 锁定 provider 版本；③ 跑 terraform init/plan 验证。
#
# 覆盖组件（与 services/api 现有集成点对齐）：
#   1) PostgreSQL （DATABASE_URL）—— users/memberships/jobs/parts/releases 持久层
#   2) Cloudflare R2（STORAGE_DRIVER=r2）—— STEP 源文件 / 解析 mesh / NC 产物
#   3) 容器服务（API 网关 + 前端静态托管 + 可选 worker）
# =============================================================================

terraform {
  required_version = ">= 1.5.0"

  # 说明：provider 块仅占位，未写 source/version 以避免无网/无凭据环境 init 失败。
  # 真实落地时按需打开其中一段：
  #
  # required_providers {
  #   postgresql = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  #   aws        = { source = "hashicorp/aws",        version = "~> 5.0" }  # R2 走 S3 兼容 API
  #   cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
  # }
}

# -----------------------------------------------------------------------------
# 1) PostgreSQL（占位）
#    生产形态建议：托管 Postgres（Neon / Supabase / RDS / 自建 EKS StatefulSet）。
#    此处用 local_file 渲染 DSN 模板，不真的建库；真实落地替换为对应 provider 资源。
# -----------------------------------------------------------------------------
resource "local_file" "database_url_template" {
  filename = "${path.module}/.out/database_url.env"
  content  = <<-EOT
# 由 terraform 渲染的占位连接串模板。
# 真实值在 terraform apply 后由对应 provider 资源输出替换。
DATABASE_URL=postgresql://${var.db_user}:${var.db_password}@${var.db_host}:${var.db_port}/${var.db_name}?sslmode=require
  EOT
}

# -----------------------------------------------------------------------------
# 2) Cloudflare R2 对象存储（占位）
#    services/api/storage/r2-adapter.ts 已对接 S3 兼容协议。
#    真实落地：cloudflare_r2_bucket + 访问密钥（R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）。
# -----------------------------------------------------------------------------
resource "local_file" "r2_env_template" {
  filename = "${path.module}/.out/r2.env"
  content  = <<-EOT
# R2 占位环境变量模板。
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=${var.r2_account_id}
R2_BUCKET=${var.r2_bucket}
# R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_PUBLIC_URL 在真实 apply 后由 secret 管理注入。
  EOT
}

# -----------------------------------------------------------------------------
# 3) 容器服务（占位）
#    API 服务：Node/Fastify（services/api），监听 8080，需注入 DATABASE_URL / JWT_SECRET / R2_*。
#    Web 静态：Vite 构建产物（apps/web/dist），托管到 CDN/对象存储。
#    真实落地：Cloudflare Workers / Docker on Fly / ECS / Cloud Run 任选其一。
# -----------------------------------------------------------------------------
resource "local_file" "service_env_template" {
  filename = "${path.module}/.out/service.env"
  content  = <<-EOT
# 容器服务占位环境变量模板。
PORT=8080
HOST=0.0.0.0
NODE_ENV=production
# CORS_ORIGINS 必须为精确白名单（不能 wildcard "*"），与 P2-02 cookie 跨源携带配套。
CORS_ORIGINS=${join(",", var.cors_origins)}
# JWT_SECRET / ADMIN_EMAIL / ADMIN_PASSWORD / METRICS_TOKEN 由 secret 管理注入，不进版本库。
  EOT
}

# 占位输出：真实落地时指向具体资源（r2 bucket url、pg endpoint、service url）。
output "postgres_dsn_template" {
  value       = local_file.database_url_template.filename
  description = "Postgres DSN 模板渲染路径（骨架占位）"
}

output "r2_bucket" {
  value       = var.r2_bucket
  description = "R2 bucket 名（占位）"
}

output "service_url" {
  value       = var.service_url
  description = "容器服务入口 URL（占位，未真部署）"
}
