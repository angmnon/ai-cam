/**
 * 机床与控制器主数据（12_机床刀具材料夹具数据规范 / 架构 §26）。
 * Machine 与 Controller 分离建模：Machine = 运动/行程/包络，Controller = 指令集/Post。
 */
import { z } from "zod";

export const MachineAxisConfig = z.enum(["3AXIS", "INDEXED_4AXIS", "4AXIS", "5AXIS"]);
export type MachineAxisConfig = z.infer<typeof MachineAxisConfig>;

export const MachineKinematics = z.object({
  axis_config: MachineAxisConfig,
  /** 行程（mm） */
  travel: z.object({ x: z.number().positive(), y: z.number().positive(), z: z.number().positive() }),
  /** 旋转轴（Indexed/4 轴） */
  rotation_axis: z.enum(["A", "B"]).optional(),
  /** 主轴最高转速（rpm） */
  max_spindle_rpm: z.number().positive(),
  max_feed_mm_min: z.number().positive(),
  rapid_mm_min: z.number().positive(),
  /** 工作台尺寸 */
  table_size_mm: z.object({ x: z.number(), y: z.number() }).optional(),
  /** 装夹范围限制 */
  work_cube_mm: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
});
export type MachineKinematics = z.infer<typeof MachineKinematics>;

export const Machine = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  model: z.string().optional(),
  manufacturer: z.string().optional(),
  axis_config: MachineAxisConfig,
  kinematics: MachineKinematics,
  /** 支持的控制器 id 列表 */
  supported_controllers: z.array(z.string()).min(1),
  /** 状态：AVAILABLE / MAINTENANCE / RETIRED */
  status: z.enum(["AVAILABLE", "MAINTENANCE", "RETIRED"]).default("AVAILABLE"),
  version: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Machine = z.infer<typeof Machine>;

export const Controller = z.object({
  id: z.string(),
  name: z.string(),
  /** 指令集族：ISO_GENERIC / FANUC / MITSUBISHI / SYNTEC / OTHER */
  dialect: z.enum(["ISO_GENERIC", "FANUC", "MITSUBISHI", "SYNTEC", "OTHER"]),
  /** Post 处理器版本（渲染 NC 用，版本化） */
  post_version: z.string().optional(),
  /** 支持的扩展循环：DRILLING_CYCLES / HIGH_SPEED / ... */
  capabilities: z.array(z.string()).default([]),
  version: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Controller = z.infer<typeof Controller>;
