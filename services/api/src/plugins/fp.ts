/**
 * fp 辅助（两种语义）：
 * - fp：身份包装，仅类型对齐，保留 Fastify 封装 —— 用于“只注册路由”的插件
 *   （若把路由插件包成 fastify-plugin，register(plugin, {prefix}) 的 prefix 会丢失）。
 * - fpRoot：fastify-plugin，解除封装 —— 用于需要 hook / decorate 对根上下文生效的
 *   基础设施插件（request-context / auth / error-handler）。
 */
import fpPlugin from "fastify-plugin";
import type { FastifyPluginAsync, FastifyPluginOptions } from "fastify";

export function fpRoot<T extends FastifyPluginOptions>(plugin: FastifyPluginAsync<T>): FastifyPluginAsync<T> {
  return fpPlugin(plugin);
}

export function fp<T extends FastifyPluginOptions>(plugin: FastifyPluginAsync<T>): FastifyPluginAsync<T> {
  return plugin;
}

export default fp;
