/**
 * 对象存储抽象（13_文件与对象存储规范）。
 * Key 规则：/{org_id}/{resource_type}/{resource_id}/{version}/{file}
 *
 * P0-2 安全约束：
 *  - 对象 key 由服务端在 createUploadSession 时生成并落内存会话表；
 *  - /upload 端点凭 session_id 取回 key，不再接受客户端 x-file-key；
 *  - put(key,...,orgId) 必须校验 key 以 `${orgId}/` 开头且不逃逸 dataDir。
 */
export type ResourceType =
  | "CAD_SOURCE"
  | "CAD_PARSED"
  | "VIEW_MESH"
  | "SIMULATION_MESH"
  | "TOOLPATH"
  | "FIXTURE_CAD"
  | "NC_PROGRAM"
  | "SETUP_SHEET"
  | "PROCESS_REPORT"
  | "SIMULATION_REPORT";

export interface UploadSession {
  file_id: string;
  /** 服务端会话 id；/upload 凭此取回服务端 key（替代旧的客户端 x-file-key） */
  session_id: string;
  /** 服务端生成的对象 key（orgId 前缀），客户端不可修改 */
  key: string;
  upload_url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  expires_at: string;
}

export interface FileMeta {
  file_id: string;
  org_id: string;
  resource_type: ResourceType;
  resource_id: string;
  version: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export function storageKey(orgId: string, resourceType: ResourceType, resourceId: string, version: string, filename: string): string {
  return `${orgId}/${resourceType.toLowerCase()}/${resourceId}/${version}/${filename}`;
}

export interface StorageAdapter {
  readonly driver: "local" | "r2";
  /** 创建上传会话：本地适配器返回 API 上传端点，R2 返回预签名 PUT URL */
  createUploadSession(
    orgId: string,
    resourceType: ResourceType,
    resourceId: string,
    version: string,
    filename: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<UploadSession>;
  /** 按 session_id 取回服务端 key，并校验属于当前 org（一次性，取回即作废）。
   *  P2-50：同时返回创建会话时声明的 size_bytes，供 /upload 校验实际 body 长度。 */
  consumeUploadSession(sessionId: string, orgId: string): Promise<{ key: string; sizeBytes: number }>;
  /** 保存已上传内容并计算 SHA-256；orgId 用于校验 key 租户前缀与路径安全 */
  put(key: string, data: Buffer, contentType: string, orgId: string): Promise<FileMeta>;
  get(key: string): Promise<{ data: Buffer; contentType: string }>;
  head(key: string): Promise<{ size_bytes: number } | null>;
}
