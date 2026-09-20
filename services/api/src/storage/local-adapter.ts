/** 本地磁盘适配器（开发/单机演示可用；生产切 R2） */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { FileMeta, ResourceType, StorageAdapter, UploadSession, storageKey } from "./storage.js";

export class LocalDiskAdapter implements StorageAdapter {
  readonly driver = "local" as const;

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
    const key = storageKey(orgId, resourceType, resourceId, version, filename);
    return {
      file_id: fileId,
      upload_url: `${this.baseUrl}/api/v1/files/upload`,
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-id": fileId, "x-file-key": key },
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }

  async put(key: string, data: Buffer, contentType: string): Promise<FileMeta> {
    const fileId = `file_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    const abs = join(this.dataDir, key);
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
      filename: parts[4],
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
