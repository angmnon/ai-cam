/**
 * 安全接线插件（P0-04）：把 packages/security 的能力接到 Fastify 生命周期。
 *  - decorate `auditSink`：进程内 MemoryAuditSink（持久化在阶段②做）。
 *  - decorate `authorize(action)`：返回 preHandler，从 JWT 解出 role/orgId，
 *    调用 assertCan(role, action)；通过记 ALLOWED，拒绝记 DENIED 并抛 403。
 *
 * 注意：本插件必须在 authPlugin（设置 request.user）之后、业务路由之前注册。
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { AccessDeniedError, MemoryAuditSink, recordAudit, assertCan, ROLES, type Action, type AuditSink, type Role } from "@ai-cam/security";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { fpRoot } from "./fp.js";

declare module "fastify" {
  interface FastifyInstance {
    /** 进程内审计 sink（阶段②换持久化实现） */
    auditSink: AuditSink;
    /** 工厂：返回 preHandler，对当前请求断言登录角色拥有指定 RBAC action */
    authorize: (action: Action) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const securityPlugin: FastifyPluginAsync = async (app) => {
  const sink = new MemoryAuditSink();
  app.decorate("auditSink", sink);

  app.decorate("authorize", (action: Action) => {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        throw new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "No authenticated user.", stage: "rbac" });
      }
      // JWT 角色统一大写后对齐 RBAC Role 枚举
      const rawRole = (user.roles[0] ?? "").toUpperCase();
      if (!(ROLES as readonly string[]).includes(rawRole)) {
        await recordAudit(sink, { actor: user.sub, role: rawRole || "UNKNOWN", action, resource: request.url, detail: "未知角色" }, "DENIED");
        throw new ApiError({ code: ErrorCodes.AUTH_FORBIDDEN, message: `角色 ${rawRole || "匿名"} 无 ${action} 权限`, stage: "rbac" });
      }
      const role = rawRole as Role;
      try {
        assertCan(role, action);
      } catch (e) {
        if (e instanceof AccessDeniedError) {
          await recordAudit(sink, { actor: user.sub, role, action, resource: request.url, detail: e.message }, "DENIED");
          throw new ApiError({ code: ErrorCodes.AUTH_FORBIDDEN, message: e.message, stage: "rbac" });
        }
        throw e;
      }
      await recordAudit(sink, { actor: user.sub, role, action, resource: request.url }, "ALLOWED");
    };
  });
};

export default fpRoot(securityPlugin);
