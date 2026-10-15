/**
 * Cloudflare Workers 入口（替代 Fastify index.ts）。
 *
 * - `export default { fetch }`：workerd 调用约定。
 * - 配置从 worker env（vars + secrets + Hyperdrive 绑定）构建；Hyperdrive 注入 DATABASE_URL。
 * - buildApp 单例缓存：迁移/连接池仅在首个请求时执行一次（与 workerd 同 isolate 复用）。
 * - VPS 容器部署仍走 Fastify（src/index.ts + src/app.ts），本文件为边缘 T2 部署路径。
 */
import { buildApp } from "./hono-app.js";
import { loadConfig, type AppConfig, type EnvSource } from "./config.js";
import type { AppEnv, Bindings, CfExecutionContext } from "./hono-env.js";
import type { Hono } from "hono";

/** worker env：继承 Bindings（含 vars/secrets + 绑定） */
export type WorkerEnv = Bindings;

let cached: { app: Hono<AppEnv> } | null = null;

/** 把 worker env 规整成 loadConfig 需要的 EnvSource（字符串 vars + Hyperdrive 注入 DATABASE_URL） */
function buildEnvSource(env: WorkerEnv): EnvSource {
  const src: EnvSource = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") src[k] = v;
  }
  const db = env.AI_CAM_DB as { connectionString?: string } | undefined;
  if (db?.connectionString && !src.DATABASE_URL) {
    src.DATABASE_URL = db.connectionString;
  }
  return src;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: CfExecutionContext): Promise<Response> {
    if (!cached) {
      const config: AppConfig = loadConfig(buildEnvSource(env));
      cached = { app: await buildApp({ config, env }) };
    }
    return cached.app.fetch(request, env, ctx);
  },
};
