FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm" PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/api ./services/api
RUN pnpm install --frozen-lockfile=false --filter @ai-cam/api... --filter @ai-cam/error-codes... --filter @ai-cam/job-schema... --filter @ai-cam/event-schema... --filter @ai-cam/domain-schemas...
RUN pnpm --filter @ai-cam/api build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/services/api/package.json ./services/api/package.json
COPY --from=build /repo/services/api/dist ./services/api/dist
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/node_modules ./node_modules
EXPOSE 8080
WORKDIR /app/services/api
CMD ["node", "dist/index.js"]
