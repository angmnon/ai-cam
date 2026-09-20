/** Auth 路由：演示登录（Phase 0 骨架，生产换 SSO） */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { ok } from "../plugins/response.js";
import fp from "../plugins/fp.js";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  organization_id: z.string().optional(),
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
            organization_id: { type: "string" },
          },
        },
        tags: ["auth"],
      },
    },
    async (request, reply) => {
      const body = LoginBody.safeParse(request.body);
      if (!body.success) {
        throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "Invalid login payload.", stage: "auth", details: { issues: body.error.issues } });
      }
      const { email, organization_id } = body.data;
      // Phase 0 演示：任何邮箱可登录；org 默认 "org_demo"
      if (organization_id && !organization_id.startsWith("org_")) {
        throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "organization_id must start with org_.", stage: "auth" });
      }
      const orgId = organization_id ?? "org_demo";
      const user = { sub: email.toLowerCase(), org_id: orgId, roles: ["engineer"] };
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
