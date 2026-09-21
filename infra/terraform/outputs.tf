# P2-03 IaC 骨架 — 输出
# 真实落地时，这些输出应指向具体云资源（PG endpoint / R2 bucket / 容器服务 URL）。
# 当前为骨架占位，仅渲染模板文件路径。

output "postgres_dsn_template" {
  value       = local_file.database_url_template.filename
  description = "Postgres DSN 模板渲染路径（骨架占位，非真实 DSN）"
}

output "r2_env_template" {
  value       = local_file.r2_env_template.filename
  description = "R2 环境变量模板渲染路径（骨架占位）"
}

output "service_env_template" {
  value       = local_file.service_env_template.filename
  description = "容器服务环境变量模板渲染路径（骨架占位）"
}

output "r2_bucket" {
  value       = var.r2_bucket
  description = "R2 bucket 名（占位）"
}

output "service_url" {
  value       = var.service_url
  description = "API 容器服务入口 URL（占位，未真部署）"
}
