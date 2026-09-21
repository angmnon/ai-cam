/** 请求上下文：request_id 贯穿 + 租户信息 + W3C traceparent 透传 */
import type { FastifyPluginAsync } from "fastify";
import { fpRoot } from "./fp.js";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    traceId: string;
    user?: { sub: string; org_id: string; roles: string[] };
  }
}

/**
 * P2-51：解析入站 W3C traceparent（version-traceid-parentid-flags）。
 * 仅当四段均合法（traceid/parentid 为非全零 hex）时提取 traceid；否则返回 null，由调用方生成新 traceId。
 */
function parseIncomingTraceId(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.trim().split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (!/^[0-9a-fA-F]{2}$/.test(version)) return null;
  if (!/^[0-9a-fA-F]{32}$/.test(traceId) || traceId === "0".repeat(32)) return null;
  if (!/^[0-9a-fA-F]{16}$/.test(parentId) || parentId === "0".repeat(16)) return null;
  if (!/^[0-9a-fA-F]{2}$/.test(flags)) return null;
  return traceId.toLowerCase();
}

const requestContext: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const requestId = typeof incoming === "string" && incoming.length > 0 ? incoming : `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    request.requestId = requestId;
    // W3C traceparent：合法入站 traceparent 透传其 traceid；否则生成随机 32 hex traceId
    const traceId =
      parseIncomingTraceId(typeof request.headers["traceparent"] === "string" ? request.headers["traceparent"] : undefined) ??
      crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    request.traceId = traceId;
    reply.header("x-request-id", requestId);
    reply.header("traceparent", `00-${traceId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`);
  });
};

export default fpRoot(requestContext);
