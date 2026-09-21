/** 统一成功响应体（03_API接口规范 §2） */
/** P2-52：分页元信息对齐 SQL OFFSET/LIMIT 语义（为 PG 迁移做准备） */
export interface PageMeta {
  offset: number;
  limit: number;
  total: number;
}

export function ok<T>(data: T) {
  return { data };
}

export function paged<T>(items: T, meta: PageMeta) {
  return { data: items, meta };
}
