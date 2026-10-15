/**
 * 事件总线（P0-9）：进程内发布/订阅（CloudEvents）。
 * Phase 0 为内存实现；接入 Cloudflare Queues / Redis Streams 时保持同接口。
 */
import { CloudEvent, makeCloudEvent } from "@ai-cam/event-schema";
import type { EventType } from "@ai-cam/event-schema";

export type EventHandler = (event: CloudEvent) => void;

export interface EventBus {
  publish(event: CloudEvent): void;
  publishFor(source: string, type: string, subject: string, data?: unknown): CloudEvent;
  subscribe(subject: string | null, handler: EventHandler): () => void;
}

/** subject=null 表示订阅全部事件 */
export class InMemoryEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<EventHandler>>();

  publish(event: CloudEvent): void {
    const all = this.listeners.get("*");
    const subject = this.listeners.get(event.subject);
    for (const h of all ?? []) h(event);
    for (const h of subject ?? []) h(event);
  }

  publishFor(source: string, type: string, subject: string, data?: unknown): CloudEvent {
    const event = makeCloudEvent(source, type as EventType, subject, data);
    this.publish(event);
    return event;
  }

  subscribe(subject: string | null, handler: EventHandler): () => void {
    const key = subject ?? "*";
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }
}
