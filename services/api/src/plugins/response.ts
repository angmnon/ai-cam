/** 统一成功响应体（03_API接口规范 §2） */
export interface PageMeta {
  page: number;
  page_size: number;
  total: number;
}

export function ok<T>(data: T) {
  return { data };
}

export function paged<T>(items: T, meta: PageMeta) {
  return { data: items, meta };
}
