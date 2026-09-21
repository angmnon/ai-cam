/** 本地磁盘适配器（开发/单机演示可用；生产切 R2）
 *
 * P0-2 加固：
 *  - createUploadSession 在服务端生成 key 并落内存会话表（session_id → { key, orgId, size }）；
 *  - consumeUploadSession 凭 session_id 取回 key，校验属于当前 org，一次性；
 *  - put() 强制 key 以 `${orgId}/` 开头，并拒绝任何逃逸 dataDir 的路径（路径穿越/绝对路径）。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { FileMeta, ResourceType, StorageAdapter, UploadSession, storageKey } from "./storage.js";

/** 内存上传会话：session_id → 服务端 key / 租户 / 大小 / 过期时间 */
interface UploadSessionEntry {
  key: string;
  orgId: string;
  size: number;
  expiresAt: number;
}

export class LocalDiskAdapter implements StorageAdapter {
  readonly driver = "local" as const;

  /** 进程内上传会话表（Phase 0；阶段②换 PG/Redis） */
  private readonly sessions = new Map<string, UploadSessionEntry>();

  constructor(private readonly dataDir: string, private readonly baseUrl = "http://localhost:8080") {}

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  }

  async createUploadSession(
    orgId: string,
    resourceType: ResourceType,
    resourceId: string,
    version: string,
    filename: string,
    _contentType: string,
    sizeBytes: number,
  ): Promise<UploadSession> {
    if (sizeBytes <= 0) {
      throw new ApiError({ code: ErrorCodes.FILE_INVALID_TYPE, message: "size_bytes must be positive.", stage: "files" });
    }
    if (sizeBytes > 512 * 1024 * 1024) {
      throw new ApiError({ code: ErrorCodes.FILE_TOO_LARGE, message: "File exceeds 512MB limit.", stage: "files" });
    }
    const fileId = `file_${randomUUID().replaceAll("-", "")}`;
    const sessionId = `sess_${randomUUID().replaceAll("-", "")}`;
    // key 由服务端生成（orgId 来自 JWT），形如 {orgId}/{resource_type}/{resource_id}/{version}/{filename}
    const key = storageKey(orgId, resourceType, resourceId, version, filename);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    // 落内存会话表：后续 /upload 凭 session_id 取回，客户端不可改 key
    this.sessions.set(sessionId, { key, orgId, size: sizeBytes, expiresAt });
    return {
      file_id: fileId,
      session_id: sessionId,
      key,
      upload_url: `${this.baseUrl}/api/v1/files/upload`,
      method: "POST",
      // 不再下发 x-file-key；客户端只回传 x-session-id
      headers: { "content-type": "application/octet-stream", "x-session-id": sessionId },
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  async consumeUploadSession(sessionId: string, orgId: string): Promise<{ key: string }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new ApiError({ code: ErrorCodes.FILE_SIGNATURE_INVALID, message: "Unknown or expired upload session.", stage: "files" });
    }
    // 校验会话属于当前 org（JWT 解算），跨租户直接拒绝并作废
    if (entry.orgId !== orgId) {
      this.sessions.delete(sessionId);
      throw new ApiError({ code: ErrorCodes.AUTH_TENANT_MISMATCH, message: "Upload session does not belong to current org.", stage: "files" });
    }
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(sessionId);
      throw new ApiError({ code: ErrorCodes.FILE_SIGNATURE_INVALID, message: "Upload session expired.", stage: "files" });
    }
    // 一次性：取回即作废
    this.sessions.delete(sessionId);
    return { key: entry.key };
  }

  async put(key: string, data: Buffer, contentType: string, orgId: string): Promise<FileMeta> {
    // 1) 租户前缀校验：key 必须以当前 orgId 开头
    if (!key.startsWith(`${orgId}/`)) {
      throw new ApiError({ code: ErrorCodes.AUTH_TENANT_MISMATCH, message: `Object key must start with ${orgId}/.`, stage: "files" });
    }
    // 2) 路径穿越防护：拒绝绝对路径/反斜杠/null 字节
    if (isAbsolute(key) || key.includes("\\") || key.includes("\0")) {
      throw new ApiError({ code: ErrorCodes.FILE_SIGNATURE_INVALID, message: "Invalid object key: illegal characters.", stage: "files" });
    }
    // 3) 解析后逃逸 dataDir（含 ..）或仍为绝对路径则拒绝
    const rel = relative(this.dataDir, resolve(this.dataDir, key));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ApiError({ code: ErrorCodes.FILE_SIGNATURE_INVALID, message: "Invalid object key: path traversal detected.", stage: "files" });
    }

    const fileId = `file_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    const abs = join(this.dataDir, rel);
    await this.ensureDir(dirname(abs));
    await writeFile(abs, data);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const parts = key.split("/");
    return {
      file_id: fileId,
      org_id: parts[0],
      resource_type: parts[1].toUpperCase() as ResourceType,
      resource_id: parts[2],
      version: parts[3],
      filename: basename(parts[4]),
      content_type: contentType,
      size_bytes: data.length,
      sha256,
      created_at: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string }> {
    const abs = join(this.dataDir, key);
    try {
      const data = await readFile(abs);
      return { data, contentType: "application/octet-stream" };
    } catch {
      throw new ApiError({ code: ErrorCodes.FILE_NOT_FOUND, message: `Object not found: ${key}`, stage: "files" });
    }
  }

  async head(key: string): Promise<{ size_bytes: number } | null> {
    const abs = join(this.dataDir, key);
    try {
      const s = await stat(abs);
      return { size_bytes: s.size };
    } catch {
      return null;
    }
  }
}
