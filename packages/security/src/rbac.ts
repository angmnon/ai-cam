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

export function assertCan(role: Role, action: Action): void {
  if (!can(role, action)) {
    throw new AccessDeniedError(role, action);
  }
}

export class AccessDeniedError extends Error {
  constructor(public role: Role, public action: Action) {
    super(`权限不足：角色 ${role} 无 ${action} 权限`);
  }
}

export function matrixOf(): Record<Role, readonly Action[]> {
  return MATRIX;
}
