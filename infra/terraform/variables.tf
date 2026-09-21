# P2-03 IaC 骨架 — 变量声明
# 说明：所有变量均带占位默认值，便于在无云账号环境 `terraform validate` 通过；
#       真实 apply 时通过 -var / .tfvars / CI secret 覆盖。

variable "db_host" {
  type        = string
  description = "Postgres 主机（占位，真实值由托管 PG 资源输出）"
  default     = "postgres.internal"
}

variable "db_port" {
  type        = number
  description = "Postgres 端口"
  default     = 5432
}

variable "db_name" {
  type        = string
  description = "Postgres 库名"
  default     = "ai_cam"
}

variable "db_user" {
  type        = string
  description = "Postgres 用户名（占位；真实值走 secret）"
  default     = "ai_cam_app"
}

variable "db_password" {
  type        = string
  description = "Postgres 密码（占位；真实值必须走 secret，禁止入库）"
  default     = "CHANGE_ME"
  sensitive   = true
}

variable "r2_account_id" {
  type        = string
  description = "Cloudflare Account ID（占位）"
  default     = "CHANGE_ME"
}

variable "r2_bucket" {
  type        = string
  description = "R2 bucket 名（占位）"
  default     = "ai-cam-assets"
}

variable "cors_origins" {
  type        = list(string)
  description = "Web 前端 Origin 白名单（精确匹配，禁止 wildcard；与 P2-02 cookie credentials 配套）"
  default     = ["https://app.ai-cam.example.com"]
}

variable "service_url" {
  type        = string
  description = "API 容器服务入口 URL（占位，未真部署）"
  default     = "https://api.ai-cam.example.com"
}
