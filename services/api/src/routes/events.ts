/** SSE 事件流路由（P0-9）：GET /api/v1/events/stream?subject=job_xxx */
import type { FastifyPluginAsync } from "fastify";
import type { CloudEvent, EventType } from "@ai-cam/event-schema";
import { formatSse, sseComment, sseRetry } from "@ai-cam/event-schema";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import fp from "../plugins/fp.js";

const HEARTBEAT_MS = 15_000;

export function attachSseStream(
  reply: { raw: import("node:http").ServerResponse },
  bus: { subscribe(subject: string | null, handler: (e: CloudEvent) => void): () => void },
  subject: string | null,
  heartbeatMs = HEARTBEAT_MS,
  /** P1-19：可选事件过滤（如跨 org 过滤），返回 false 则不下发；支持异步（PG store） */
  filter?: (event: CloudEvent) => boolean | Promise<boolean>,
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
  res.write(formatSse({ specversion: "1.0", id: "evt_hello", source: "com.aicam.api", type: "hello" as EventType, subject: subject ?? "*", time: new Date().toISOString(), datacontenttype: "application/json" }));

  const unsubscribe = bus.subscribe(subject, (event) => {
    if (filter) {
      const verdict = filter(event);
      if (typeof verdict === "boolean") {
        if (!verdict) return; // P1-19：越权事件丢弃
      } else {
        // 异步过滤（PG store）：微任务按调用顺序回写，保持 SSE 顺序
        verdict.then((ok) => {
          if (ok) res.write(formatSse(event));
        });
        return;
      }
    }
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
      const orgId = request.user!.org_id;
      if (subject) {
        if (!subject.startsWith("job_")) {
          throw new ApiError({ code: ErrorCodes.SYSTEM_VALIDATION, message: "subject must start with job_.", stage: "events" });
        }
        // P1-19：订阅指定 job 前先校验该 job 属于当前 org，跨 org/不存在即拒绝
        await app.jobs.get(orgId, subject);
      }
      // P1-19：不传 subject（订阅全部）时，仅下发归属当前 org 的 job 事件
      const filter = subject
        ? undefined
        : (event: CloudEvent) => {
            if (!event.subject || !event.subject.startsWith("job_")) return false;
            return app.jobs
              .get(orgId, event.subject)
              .then(() => true)
              .catch(() => false);
          };
      const cleanup = attachSseStream(reply, app.bus, subject, HEARTBEAT_MS, filter);
      request.raw.on("close", () => {
        cleanup();
      });
      // 告知 Fastify 已接管响应
      reply.hijack();
    },
  );
};

export default fp(eventRoutes);
