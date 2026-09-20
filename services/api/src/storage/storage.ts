/**
 * 对象存储抽象（13_文件与对象存储规范）。
 * Key 规则：/{org_id}/{resource_type}/{resource_id}/{version}/{file}
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
  /** 保存已上传内容并计算 SHA-256（本地适配器由上传端点调用） */
  put(key: string, data: Buffer, contentType: string): Promise<FileMeta>;
  get(key: string): Promise<{ data: Buffer; contentType: string }>;
  head(key: string): Promise<{ size_bytes: number } | null>;
}
