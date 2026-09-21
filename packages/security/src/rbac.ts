/**
 * RBAC 权限矩阵（P5-7）：角色 × 动作的细粒度权限。
 * 角色：ADMIN（全量，含发布审批与执行）/ ENGINEER（工艺/发起发布，不自批自放）/
 *      OPERATOR（车间执行）/ VIEWER（只读）。
 * P1-1：release:approve 与 release:release 从 ENGINEER 收回，仅 ADMIN 持有（自批自放禁止）。
 */
export const ROLES = ["ADMIN", "ENGINEER", "OPERATOR", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "part:read",
  "part:analyze",
  "cam:generate",
  "job:run",
  "job:view_nc",
  "release:request",
  "release:approve",
  "release:release",
  "ai:plan",
  "ai:apply",
  "rules:manage",
  "users:manage",
  "audit:read",
] as const;
export type Action = (typeof ACTIONS)[number];

const MATRIX: Record<Role, readonly Action[]> = {
  ADMIN: [...ACTIONS],
  // ENGINEER 不再持有 release:approve / release:release（P1-1 自批自放）
  ENGINEER: ["part:read", "part:analyze", "cam:generate", "job:run", "job:view_nc", "release:request", "ai:plan", "ai:apply", "rules:manage", "audit:read"],
  OPERATOR: ["part:read", "job:run", "job:view_nc", "release:request"],
  VIEWER: ["part:read", "job:view_nc", "audit:read"],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

/**
 * P2-39 租户（org）维度上下文：role 矩阵本身不变。
 * 调用方可选地传入身份所属 orgId（如从 JWT 解出）与目标资源/事件所属 orgId；
 * 当两者都给出且不一致时视为跨租户访问并拒绝（不影响 role 授权结论）。
 */
export interface RbacContext {
  /** 当前身份所属租户 orgId */
  orgId?: string;
  /** 目标资源/事件所属租户 orgId（与 orgId 不一致即跨租户） */
  resourceOrgId?: string;
}

export function assertCan(role: Role, action: Action, ctx?: RbacContext): void {
  if (!can(role, action)) {
    throw new AccessDeniedError(role, action);
  }
  // P2-39：仅当两侧 orgId 均提供且不一致时，判定为跨租户越权
  if (ctx?.orgId && ctx.resourceOrgId && ctx.orgId !== ctx.resourceOrgId) {
    throw new CrossTenantError(role, action, ctx.orgId, ctx.resourceOrgId);
  }
}

export class AccessDeniedError extends Error {
  constructor(public role: Role, public action: Action) {
    super(`权限不足：角色 ${role} 无 ${action} 权限`);
  }
}

/** P2-39：同 role 跨租户（org）访问被拒；继承 AccessDeniedError 以便统一按 403 处理 */
export class CrossTenantError extends AccessDeniedError {
  constructor(role: Role, action: Action, public readonly orgId: string, public readonly resourceOrgId: string) {
    super(role, action);
    this.message = `跨租户访问被拒：org ${orgId} 的角色 ${role} 无权访问 org ${resourceOrgId} 的 ${action}`;
  }
}

export function matrixOf(): Record<Role, readonly Action[]> {
  return MATRIX;
}
