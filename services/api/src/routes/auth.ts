/** Auth 路由：登录（P0-01 服务端签发）+ P2-06 限流锁定 + 密码重置。
 *  - 不再接受客户端 organization_id；org_id 与 role 一律服务端解算。
 *  - 登录连续失败达阈值锁定期内任何凭据 429（LOGIN_MAX_ATTEMPTS/LOCK_MINUTES）。
 *  - POST /auth/forgot-password：生成一次性 token（1h，存表，v1 无邮件经审计回吐）。
 *  - POST /auth/reset-password：凭 token 重置（scrypt 新哈希）。
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { ok } from "../plugins/response.js";
import fp from "../plugins/fp.js";

declare module "fastify" {
  interface FastifyInstance {
    loginService: import("../auth/login-service.js").LoginService;
  }
}

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ForgotBody = z.object({ email: z.string().email() });

const ResetBody = z.object({
  token: z.string().min(1),
  new_password: z.string().min(8),
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

      const outcome = await app.loginService.login(email, password);
      if (outcome.status === "locked") {
        reply.header("retry-after", String(outcome.retryAfterSec));
        throw new ApiError({
          code: ErrorCodes.SYSTEM_RATE_LIMITED,
          message: "Account temporarily locked due to repeated failed logins. Try again later.",
          stage: "auth",
          retryable: true,
          details: { retry_after_sec: outcome.retryAfterSec },
        });
      }
      if (outcome.status === "invalid") {
        throw new ApiError({
          code: ErrorCodes.AUTH_INVALID_CREDENTIALS,
          message: "Invalid email or password.",
          stage: "auth",
          retryable: false,
        });
      }

      // JWT payload 由服务端写入：sub/org_id/roles 均为服务端解算值
      const user = outcome.identity;
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

  // P2-06：忘记密码。统一对外 200（不泄漏邮箱是否存在）；存在用户时一次性 token 经审计日志回吐。
  app.post(
    "/api/v1/auth/forgot-password",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", format: "email" } },
        },
        tags: ["auth"],
      },
    },
    async (request) => {
      const parsed = ForgotBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError({
          code: ErrorCodes.SYSTEM_VALIDATION,
          message: "Invalid forgot-password payload.",
          stage: "auth",
          details: { issues: parsed.error.issues },
        });
      }
      await app.loginService.forgotPassword(parsed.data.email);
      return ok({ message: "If the email exists, a reset token has been issued." });
    },
  );

  // P2-06：凭一次性 token 重置密码（scrypt 新哈希）。
  app.post(
    "/api/v1/auth/reset-password",
    {
      schema: {
        body: {
          type: "object",
          required: ["token", "new_password"],
          properties: {
            token: { type: "string" },
            new_password: { type: "string", minLength: 8 },
          },
        },
        tags: ["auth"],
      },
    },
    async (request) => {
      const parsed = ResetBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError({
          code: ErrorCodes.SYSTEM_VALIDATION,
          message: "Invalid reset-password payload.",
          stage: "auth",
          details: { issues: parsed.error.issues },
        });
      }
      const ok2 = await app.loginService.resetPassword(parsed.data.token, parsed.data.new_password);
      if (!ok2) {
        throw new ApiError({
          code: ErrorCodes.AUTH_INVALID_CREDENTIALS,
          message: "Reset token is invalid, expired, or already used.",
          stage: "auth",
          retryable: false,
        });
      }
      return ok({ message: "Password updated successfully." });
    },
  );
};

export default fp(authRoutes);
