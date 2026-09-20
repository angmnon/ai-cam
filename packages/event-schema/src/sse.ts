/**
 * SSE 帧编码（服务端事件流）。规则：`event:` 行 + `data:` 行 + 空行分隔。
 */
import { CloudEvent } from "./cloud-event.js";

export function formatSse(event: CloudEvent): string {
  const data = JSON.stringify(event);
  return `event: ${event.type}\ndata: ${data}\n\n`;
}

export interface SseHandshake {
  retryMs?: number;
  comment?: string;
}

export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

export function sseRetry(ms: number): string {
  return `retry: ${ms}\n\n`;
}
