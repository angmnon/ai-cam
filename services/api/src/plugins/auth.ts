/**
 * Auth：演示登录（JWT，HS256）+ 受保护路由校验。
 * Phase 0 为骨架：生产环境换 OIDC / 企业 SSO，并接入 Cloudflare Access（架构 §36）。
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { fpRoot } from "./fp.js";

export interface AuthUser {
  sub: string;
  org_id: string;
  roles: string[];
}

export interface AuthOptions {
  secret: string;
  issuer: string;
  expiresIn: string;
}

declare module "fastify" {
  interface FastifyInstance {
    auth: {
      signToken(user: AuthUser): Promise<string>;
      verifyToken(token: string): Promise<AuthUser>;
    };
  }
}

export function authPlugin(opts: AuthOptions): FastifyPluginAsync {
  const secretKey = new TextEncoder().encode(opts.secret);

  const auth: FastifyInstance["auth"] = {
    async signToken(user) {
      return new SignJWT({ org_id: user.org_id, roles: user.roles })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.sub)
        .setIssuer(opts.issuer)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn)
        .sign(secretKey);
    },
    async verifyToken(token) {
      const { payload } = await jwtVerify(token, secretKey, { issuer: opts.issuer });
      const orgId = typeof payload.org_id === "string" ? payload.org_id : "";
      const roles = Array.isArray(payload.roles) ? (payload.roles as string[]).map(String) : [];
      return { sub: payload.sub ?? "", org_id: orgId, roles };
    },
  };

  const plugin: FastifyPluginAsync = async (app) => {
    app.decorate("auth", auth);
    app.addHook("onRequest", async (request, _reply) => {
      // 公开路径
      if (request.routeOptions.url === "/health" || request.routeOptions.url === "/docs" || request.routeOptions.url?.startsWith("/docs/")) {
        return;
      }
      if (request.routeOptions.url === "/api/v1/auth/login") {
        return;
      }
      // P2-06：密码自助端点无需 JWT（token 自身即凭据）
      if (request.routeOptions.url === "/api/v1/auth/forgot-password" || request.routeOptions.url === "/api/v1/auth/reset-password") {
        return;
      }
      // P2-01：Prometheus 抓取端点（由路由内自行用 METRICS_TOKEN 校验）
      if (request.routeOptions.url === "/metrics") {
        return;
      }
      const header = request.headers.authorization;
      if (!header || !header.startsWith("Bearer ")) {
        throw new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "Missing bearer token.", stage: "auth" });
      }
      try {
        const user = await auth.verifyToken(header.slice(7));
        request.user = user;
      } catch {
        throw new ApiError({ code: ErrorCodes.AUTH_TOKEN_EXPIRED, message: "Invalid or expired token.", stage: "auth" });
      }
    });
  };
  return fpRoot(plugin);
}
