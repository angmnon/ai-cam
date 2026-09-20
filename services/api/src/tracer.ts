/**
 * 最小可观测性基座（P0-10）。
 * 使用 @opentelemetry/api：默认 noop，配置 OTLP_ENDPOINT 后接入导出器（后续阶段）。
 * 保证 request_id / trace_id / job_id 贯穿日志。
 */
import { createHash, randomUUID } from "node:crypto";
import { trace, SpanKind, context } from "@opentelemetry/api";

const tracer = trace.getTracer("ai-cam.api");

/** 生成 request_id（同时作为 trace_id 基） */
export function newRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** trace_id 需要 32 位 hex；从 request_id 派生，保证日志可串联 */
export function deriveTraceId(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 32);
}

export interface SpanLog {
  requestId: string;
  jobId?: string;
  stage?: string;
}

/** 记录一个阶段的执行（同步调用）：生产接入 OTel 导出器后自动上报 */
export function runSpan<T>(name: string, log: SpanLog, fn: () => T): T {
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes: { request_id: log.requestId, job_id: log.jobId ?? "" } },
    context.active(),
    (span) => {
      try {
        return fn();
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: 2 });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}
