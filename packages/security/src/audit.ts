/**
 * 审计日志（P5-7）：追加式 JSONL 审计 + 查询。
 * 覆盖：权限操作（含被拒）、AI 规划、发布审批、规则变更等安全相关事件。
 *
 * P1-13：recordAudit 改为 async 并 await sink.append（不再 fire-and-forget）；
 * 新增 FileAuditSink 持久化到文件（JSONL，目录自动创建，写失败抛错）；
 * queryAudit 统一支持可读回的 sink（MemoryAuditSink / FileAuditSink）。
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

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

/** 可读回事件流的审计 sink（供 queryAudit 使用） */
export interface AuditQuerySource {
  /** 按写入顺序读回全部事件 */
  readAll(): Promise<AuditEvent[]>;
}

export class MemoryAuditSink implements AuditSink, AuditQuerySource {
  private events: AuditEvent[] = [];
  async append(ev: AuditEvent): Promise<void> {
    this.events.push(ev);
  }
  all(): AuditEvent[] {
    return [...this.events];
  }
  async readAll(): Promise<AuditEvent[]> {
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

/**
 * 文件审计 sink：追加写 JSONL（换行分隔）到可配置文件路径。
 * 构造时传 filePath；目录不存在自动创建；append 为异步写且调用方必须 await，
 * 写盘失败时 Promise reject（错误向上抛出）。
 */
export class FileAuditSink implements AuditSink, AuditQuerySource {
  constructor(private readonly filePath: string) {}

  async append(ev: AuditEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // 以追加 + 排他方式写入，避免并发覆盖；写盘失败直接抛错
    await appendFile(this.filePath, JSON.stringify(ev) + "\n", { flag: "a", encoding: "utf8" });
  }

  async readAll(): Promise<AuditEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      // 文件尚不存在视为空日志；其余 IO 错误向上抛
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: AuditEvent[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t.length === 0) continue;
      out.push(JSON.parse(t) as AuditEvent);
    }
    return out;
  }
}

export interface AuditOptions {
  actor: string;
  role: string;
  action: string;
  resource: string;
  detail?: string;
}

/** 记录权限操作：denied 时 outcome=DENIED；await 落盘，写失败抛错 */
export async function recordAudit(sink: AuditSink, opts: AuditOptions, outcome: AuditEvent["outcome"]): Promise<AuditEvent> {
  const ev: AuditEvent = { id: randomUUID(), ts: new Date().toISOString(), ...opts, outcome };
  await sink.append(ev);
  return ev;
}

export async function queryAudit(source: AuditQuerySource, filter: { actor?: string; action?: string; outcome?: AuditEvent["outcome"] } = {}): Promise<AuditEvent[]> {
  const all = await source.readAll();
  return all.filter((e) => (!filter.actor || e.actor === filter.actor) && (!filter.action || e.action === filter.action) && (!filter.outcome || e.outcome === filter.outcome));
}
