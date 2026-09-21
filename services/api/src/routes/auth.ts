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
import { verifyLoginPassword } from "../plugins/credentials.js";

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
      const boot = app.bootstrap;

      // 服务端解算：邮箱必须匹配 bootstrap 账号（大小写不敏感），
      // org_id/role 一律来自服务端配置，客户端传入的任何值都被忽略。
      const emailOk = email.trim().toLowerCase() === boot.email;
      const pwOk = await verifyLoginPassword(password, { password: boot.password, hash: boot.passwordHash });
      if (!emailOk || !pwOk) {
        // 失败统一 401，错误响应不回显堆栈/具体失败点
        throw new ApiError({
          code: ErrorCodes.AUTH_INVALID_CREDENTIALS,
          message: "Invalid email or password.",
          stage: "auth",
          retryable: false,
        });
      }

      // JWT payload 由服务端写入：sub/org_id/roles 均为服务端解算值
      const user = { sub: boot.email, org_id: boot.orgId, roles: [boot.role] };
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
