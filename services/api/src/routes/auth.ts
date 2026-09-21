/** Auth 路由：登录（P0-01 服务端签发）。
 *  - 不再接受客户端 organization_id；org_id 与 role 一律服务端解算。
 *  - Phase 0 轻量 bootstrap 单账号（CAM_BOOTSTRAP_EMAIL/PASSWORD[_HASH]）；
 *    后续接 users/memberships 表后替换。生产换 OIDC/企业 SSO。
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { ok } from "../plugins/response.js";
import fp from "../plugins/fp.js";

// body 仍用 zod 校验；email/password 必传；不再接受 organization_id
const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/v1/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
        },
        tags: ["auth"],
      },
    },
    async (request, reply) => {
      const parsed = LoginBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError({
          code: ErrorCodes.SYSTEM_VALIDATION,
          message: "Invalid login payload.",
          stage: "auth",
          details: { issues: parsed.error.issues },
        });
      }
      const { email, password } = parsed.data;

      // P0-03：凭据校验走 AuthBackend（内存降级 = bootstrap 单账号；PG = users/memberships 解算 org/role）。
      // 任何失败（用户不存在/密码错误/已禁用）统一返回 null → 401，不回显具体失败点。
      // org_id/role 一律服务端解算，客户端传入的 organization_id 被完全忽略。
      const identity = await app.authBackend.verify(email, password);
      if (!identity) {
        throw new ApiError({
          code: ErrorCodes.AUTH_INVALID_CREDENTIALS,
          message: "Invalid email or password.",
          stage: "auth",
          retryable: false,
        });
      }

      // JWT payload 由服务端写入：sub/org_id/roles 均为服务端解算值
      const user = identity;
      const token = await app.auth.signToken(user);
      return reply.status(200).send(
        ok({
          token,
          token_type: "Bearer",
          expires_in: "24h",
          user,
        }),
      );
    },
  );
};

export default fp(authRoutes);
