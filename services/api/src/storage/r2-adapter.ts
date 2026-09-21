/**
 * R2（Cloudflare）/ S3 兼容对象存储适配器（P0-04）。
 *
 * 与 LocalDiskAdapter 行为对齐：
 *  - createUploadSession 在服务端生成 key 并落内存会话表；前端用返回的 presigned PUT URL 直传；
 *  - consumeUploadSession 凭 session_id 取回服务端 key，校验租户/过期，一次性；
 *  - put() 强制 key 以 `${orgId}/` 开头并拒绝非法字符/路径逃逸；
 *  - 上传后计算 SHA-256，返回 FileMeta。
 *
 * 端点：默认 `https://{accountId}.r2.cloudflarestorage.com`；显式 R2_ENDPOINT 时
 * （如本地 MinIO `http://localhost:9000`）开启 forcePathStyle 以兼容 S3 路径风格。
 */
import { createHash, randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { FileMeta, ResourceType, StorageAdapter, UploadSession, storageKey } from "./storage.js";

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  /** 自定义 S3 端点（如 MinIO）；缺省走 R2 官方域名 */
  endpoint?: string;
}

/** presigned PUT/GET 短期过期时间（秒）——15 分钟（前端直传窗口） */
const PRESIGN_TTL_SECONDS = 900;
const SESSION_TTL_MS = 15 * 60 * 1000;

interface UploadSessionEntry {
  key: string;
  orgId: string;
  size: number;
  expiresAt: number;
}

export class R2Adapter implements StorageAdapter {
  readonly driver = "r2" as const;
  private readonly client: S3Client;
  private readonly sessions = new Map<string, UploadSessionEntry>();

  constructor(private readonly opts: R2Options) {
    const customEndpoint = opts.endpoint?.trim();
    this.client = new S3Client({
      region: "auto",
      // 自定义端点（MinIO 等）走 path style；R2 官方域名用虚拟主机风格
      forcePathStyle: Boolean(customEndpoint),
      endpoint: customEndpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  /** 校验对象 key 的租户前缀与路径安全（与 LocalDiskAdapter 一致） */
  private assertKeySafe(key: string, orgId: string): void {
    if (!key.startsWith(`${orgId}/`)) {
      throw new ApiError({ code: ErrorCodes.AUTH_TENANT_MISMATCH, message: `Object key must start with ${orgId}/.`, stage: "files" });
    }
    if (key.includes("\\") || key.includes("\0") || key.includes("..")) {
      throw new ApiError({ code: ErrorCodes.FILE_SIGNATURE_INVALID, message: "Invalid object key: illegal characters.", stage: "files" });
    }
  }

  async createUploadSession(
    orgId: string,
    resourceType: ResourceType,
    resourceId: string,
    version: string,
    filename: string,
    contentType: string,
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
    const key = storageKey(orgId, resourceType, resourceId, version, filename);
    const expiresAt = Date.now() + SESSION_TTL_MS;

    // 服务端生成 presigned PUT URL，前端直传；会话表记录 key 供 consumeUploadSession 取回
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, ContentType: contentType }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );

    this.sessions.set(sessionId, { key, orgId, size: sizeBytes, expiresAt });
    return {
      file_id: fileId,
      session_id: sessionId,
      key,
      upload_url: uploadUrl,
      method: "PUT",
      headers: { "content-type": contentType },
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  async consumeUploadSession(sessionId: string, orgId: string): Promise<{ key: string; sizeBytes: number }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new ApiError({ code: ErrorCodes.FILE_SIGNATURE_INVALID, message: "Unknown or expired upload session.", stage: "files" });
    }
    if (entry.orgId !== orgId) {
      this.sessions.delete(sessionId);
      throw new ApiError({ code: ErrorCodes.AUTH_TENANT_MISMATCH, message: "Upload session does not belong to current org.", stage: "files" });
    }
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(sessionId);
      throw new ApiError({ code: ErrorCodes.FILE_SIGNATURE_INVALID, message: "Upload session expired.", stage: "files" });
    }
    this.sessions.delete(sessionId);
    return { key: entry.key, sizeBytes: entry.size };
  }

  async put(key: string, data: Buffer, contentType: string, orgId: string): Promise<FileMeta> {
    this.assertKeySafe(key, orgId);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: data, ContentType: contentType }),
    );
    const sha256 = createHash("sha256").update(data).digest("hex");
    const parts = key.split("/");
    return {
      file_id: `file_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
      org_id: parts[0],
      resource_type: parts[1].toUpperCase() as ResourceType,
      resource_id: parts[2],
      version: parts[3],
      filename: parts.slice(4).join("/"),
      content_type: contentType,
      size_bytes: data.length,
      sha256,
      created_at: new Date().toISOString(),
    };
  }

  async get(key: string): Promise<{ data: Buffer; contentType: string }> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      const data = Buffer.from(await res.Body!.transformToByteArray());
      return { data, contentType: res.ContentType ?? "application/octet-stream" };
    } catch {
      throw new ApiError({ code: ErrorCodes.FILE_NOT_FOUND, message: `Object not found: ${key}`, stage: "files" });
    }
  }

  async head(key: string): Promise<{ size_bytes: number } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return { size_bytes: res.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  /** 生成短期过期的 presigned GET URL（前端直读下载） */
  async presignedGetUrl(key: string, ttlSeconds: number = PRESIGN_TTL_SECONDS): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }
}
