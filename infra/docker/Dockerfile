# 多阶段构建（API 服务，prod deps only）
# 构建上下文为仓库根：docker build -f infra/docker/Dockerfile -t ai-cam/api:local .

# ---- base：统一 node + corepack（pnpm 11.5.3）----
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- build：拷贝 workspace 清单（利用缓存），再拷源码 ----
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY . .
# 仅安装 api 及其 workspace 依赖包的全量依赖，再编译 api（含依赖包 tsc）
RUN pnpm install --frozen-lockfile --filter @ai-cam/api...
RUN pnpm --filter @ai-cam/api... build

# ---- runtime：仅部署 api 生产依赖到干净目录 ----
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app .
# pnpm 11 deploy 需 --legacy（否则 ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE）
RUN pnpm --filter @ai-cam/api deploy --prod --legacy /out/api
WORKDIR /out/api
EXPOSE 8080
CMD ["node", "dist/index.js"]
