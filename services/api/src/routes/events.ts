/** SSE 事件流路由（P0-9）：GET /api/v1/events/stream?subject=job_xxx */
import type { FastifyPluginAsync } from "fastify";
import type { CloudEvent } from "@ai-cam/event-schema";
import { formatSse, sseComment, sseRetry } from "@ai-cam/event-schema";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import fp from "../plugins/fp.js";

const HEARTBEAT_MS = 15_000;

export function attachSseStream(
  reply: { raw: import("node:http").ServerResponse },
  bus: { subscribe(subject: string | null, handler: (e: CloudEvent) => void): () => void },
  subject: string | null,
  heartbeatMs = HEARTBEAT_MS,
): () => void {
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(sseComment("connected to ai-cam event stream"));
  res.write(sseRetry(3_000));
  res.write(formatSse({ specversion: "1.0", id: "evt_hello", source: "com.aicam.api", type: "hello", subject: subject ?? "*", time: new Date().toISOString(), datacontenttype: "application/json" }));

  const unsubscribe = bus.subscribe(subject, (event) => {
    res.write(formatSse(event));
  });

  const heartbeat = setInterval(() => {
    res.write(sseComment("heartbeat"));
  }, heartbeatMs);

  return () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
}

const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/stream",
    {
      schema: {
        querystring: { type: "object", properties: { subject: { type: "string" } } },
        tags: ["events"],
      },
    },
    async (request, reply) => {
      const subject = (request.query as { subject?: string }).subject ?? null;
      if (subject && !subject.startsWith("job_")) {
        throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "subject must start with job_.", stage: "events" });
      }
      const cleanup = attachSseStream(reply, app.bus, subject);
      request.raw.on("close", () => {
        cleanup();
      });
      // 告知 Fastify 已接管响应
      reply.hijack();
    },
  );
};

export default fp(eventRoutes);
