/**
 * R2（Cloudflare）适配器骨架。
 * Phase 0 已定义完整接口与 Key 规则；接入时按 Cloudflare API 生成预签名 PUT URL
 * （S3 兼容 API 或 Workers 签名端点），并把 createUploadSession 的
 * upload_url 换成预签名 URL。未配置 R2 环境变量时明确报错，不静默降级。
 */
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { FileMeta, ResourceType, StorageAdapter, UploadSession, storageKey } from "./storage.js";

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
}

export class R2Adapter implements StorageAdapter {
  readonly driver = "r2" as const;

  constructor(private readonly opts: R2Options) {}

  async createUploadSession(
    orgId: string,
    resourceType: ResourceType,
    resourceId: string,
    version: string,
    filename: string,
    _contentType: string,
    _sizeBytes: number,
  ): Promise<UploadSession> {
    const key = storageKey(orgId, resourceType, resourceId, version, filename);
    // TODO(phase-1): 调用 Cloudflare R2 S3 兼容 presign API 生成 PUT URL。
    // 结构保证：返回 { upload_url, method: "PUT", headers: {...} }，前端直传。
    throw new ApiError({
      code: ErrorCodes.SYSTEM_UPSTREAM_UNAVAILABLE,
      message: `R2 presign not implemented yet (key=${key}, bucket=${this.opts.bucket}). STORAGE_DRIVER=local for dev.`,
      stage: "files",
      retryable: false,
    });
  }

  /** R2 模式下由前端直传预签名 URL，本地会话表不参与；接入时按 R2 预签名流程实现 */
  async consumeUploadSession(_sessionId: string, _orgId: string): Promise<{ key: string; sizeBytes: number }> {
    throw new ApiError({
      code: ErrorCodes.SYSTEM_UPSTREAM_UNAVAILABLE,
      message: "R2 consumeUploadSession not implemented yet.",
      stage: "files",
    });
  }

  async put(_key: string, _data: Buffer, _contentType: string, _orgId: string): Promise<FileMeta> {
    throw new ApiError({
      code: ErrorCodes.SYSTEM_UPSTREAM_UNAVAILABLE,
      message: "R2 put not implemented yet.",
      stage: "files",
    });
  }

  async get(_key: string): Promise<{ data: Buffer; contentType: string }> {
    throw new ApiError({
      code: ErrorCodes.SYSTEM_UPSTREAM_UNAVAILABLE,
      message: "R2 get not implemented yet.",
      stage: "files",
    });
  }

  async head(_key: string): Promise<{ size_bytes: number } | null> {
    return null;
  }
}
