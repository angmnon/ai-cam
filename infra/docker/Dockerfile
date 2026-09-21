# 最小可构建镜像（API 服务骨架）
# 构建上下文为仓库根：docker build -f infra/docker/Dockerfile -t ai-cam/api .
FROM node:20-alpine

# 仓库 packageManager=pnpm@11.5.3，node:20-alpine 自带 corepack
RUN corepack enable

WORKDIR /app

COPY package*.json ./
RUN pnpm install --frozen-lockfile

COPY . .

CMD ["node", "dist/api/server.js"]
