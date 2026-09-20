/**
 * 审计日志（P5-7）：追加式 JSONL 审计 + 查询。
 * 覆盖：权限操作（含被拒）、AI 规划、发布审批、规则变更等安全相关事件。
 */
import { randomUUID } from "node:crypto";

export interface AuditEvent {
  id: string;
  ts: string;
  actor: string;
  role: string;
  action: string;
  resource: string;
  outcome: "ALLOWED" | "DENIED" | "FAILED";
  detail?: string;
}

export interface AuditSink {
  append(ev: AuditEvent): Promise<void>;
}

export class MemoryAuditSink implements AuditSink {
  private events: AuditEvent[] = [];
  async append(ev: AuditEvent): Promise<void> {
    this.events.push(ev);
  }
  all(): AuditEvent[] {
    return [...this.events];
  }
}

export class JsonlAuditSink implements AuditSink {
  private lines: string[] = [];
  async append(ev: AuditEvent): Promise<void> {
    this.lines.push(JSON.stringify(ev));
  }
  /** 输出当前日志（可写盘） */
  export(): string {
    return this.lines.join("\n");
  }
}

export interface AuditOptions {
  actor: string;
  role: string;
  action: string;
  resource: string;
  detail?: string;
}

/** 记录权限操作：denied 时 outcome=DENIED */
export function recordAudit(sink: AuditSink, opts: AuditOptions, outcome: AuditEvent["outcome"]): AuditEvent {
  const ev: AuditEvent = { id: randomUUID(), ts: new Date().toISOString(), ...opts, outcome };
  void sink.append(ev);
  return ev;
}

export function queryAudit(sink: MemoryAuditSink, filter: { actor?: string; action?: string; outcome?: AuditEvent["outcome"] } = {}): AuditEvent[] {
  return sink.all().filter((e) => (!filter.actor || e.actor === filter.actor) && (!filter.action || e.action === filter.action) && (!filter.outcome || e.outcome === filter.outcome));
}
