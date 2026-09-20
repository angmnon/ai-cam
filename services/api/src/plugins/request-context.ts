/** 请求上下文：request_id 贯穿 + 租户信息 */
import type { FastifyPluginAsync } from "fastify";
import { fpRoot } from "./fp.js";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    traceId: string;
    user?: { sub: string; org_id: string; roles: string[] };
  }
}

const requestContext: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const requestId = typeof incoming === "string" && incoming.length > 0 ? incoming : `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    request.requestId = requestId;
    // W3C traceparent：与下游几何/CAM worker 串联
    const traceId = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    request.traceId = traceId;
    reply.header("x-request-id", requestId);
    reply.header("traceparent", `00-${traceId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`);
  });
};

export default fpRoot(requestContext);
