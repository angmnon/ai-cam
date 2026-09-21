/**
 * Post Processor 框架（P3-5）：Controller Profile + Modal State + Formatter。
 * 目标：CAM IR → NC 文本，双向不改变几何（坐标/进给/转速原样输出，仅格式化为 NC 语法）。
 */
import type { ToolpathMove } from "@ai-cam/cam-ir";

export const POST_CORE_VERSION = "0.1.0";

// ---------- Controller Profile ----------
export interface ControllerProfile {
  /** 控制器方言标识（与 master-data dialect 对齐） */
  dialect: "FANUC" | "SYNTEC" | "MITSUBISHI" | "ISO_GENERIC";
  /** post 版本 */
  post_version: string;
  capabilities: string[];
  /** NC 行号步进 */
  lineStep: number;
  /** 坐标小数位 */
  decimals: number;
  /** 是否输出 G43/H 刀长补偿 */
  toolLengthComp: boolean;
  /** 是否用钻孔循环 G81/G83 */
  drillingCycles: boolean;
  /** 程序号前缀（FANUC=O / ISO 通用可空） */
  programPrefix: string;
  /** 冷却 M 代码映射 */
  coolantCodes: Record<string, string>;
  /** 是否输出回零 */
  homeAtEnd: boolean;
  /** 回零 G 代码（FANUC/SYNTEC=G28，MITSUBISHI=G30 第二参考点） */
  homeCode: "G28" | "G30";
  // ---- H-3 校准字段（可选用；由 calibrateProfile 注入真实机床参数） ----
  rapidWord?: string;
  safeHeightMm?: number;
  programHeaderTemplate?: string;
  toolChangeTemplate?: string;
  defaultFeedMmMin?: number;
  drillCycle?: "G81" | "G83" | "G73";
  peckIncrementMm?: number;
  // ---- P2-32 版本固化（可选用；由上下文/校准注入，缺省 post 输出 "unknown"） ----
  /** 刀具库版本号 */
  toolLibraryVersion?: string;
  /** 材料牌号/版本号 */
  materialVersion?: string;
  /** 机床控制器固件版本 */
  machineFirmware?: string;
}

// ---------- Modal State ----------
export interface ModalState {
  currentTool: string | null;
  toolNumber: number;
  spindleOn: boolean;
  spindleSpeed: number | null;
  coolant: string | null;
  lastG: string | null;
  lastX: number | null;
  lastY: number | null;
  lastZ: number | null;
  lastI: number | null;
  lastJ: number | null;
  lastF: number | null;
}

export function createModalState(): ModalState {
  return { currentTool: null, toolNumber: 0, spindleOn: false, spindleSpeed: null, coolant: null, lastG: null, lastX: null, lastY: null, lastZ: null, lastI: null, lastJ: null, lastF: null };
}

// ---------- Formatter ----------
export function fmt(v: number | null | undefined, decimals: number): string {
  if (v == null) return "";
  // P2-23：精度下限为 4 位小数。旧逻辑直接 toFixed(decimals)（profile 多为 3 位），
  // 导致 |x|<0.0005 被四舍五入成 "0.000" → 去尾零后丢成 "0"。
  // 现按 max(decimals, 4) 定精度再去尾零，保证最小非零值保留到 0.0001 级。
  const eff = Math.max(decimals, 4);
  const s = v.toFixed(eff);
  // 去尾零（保留 1 位最少）
  let out = s.replace(/\.?0+$/, "");
  if (out === "-0") out = "0";
  if (out === "") out = "0";
  return out;
}

// ---------- NC 行构建 ----------
export class NcWriter {
  readonly lines: string[] = [];
  private lineNo: number;
  constructor(private profile: ControllerProfile, startLine = 10) {
    this.lineNo = startLine;
  }
  /** 输出带行号的 NC 行（motion 行），返回当前行号 */
  emit(text: string): number {
    const n = this.lineNo;
    this.lines.push(`N${n} ${text}`);
    this.lineNo += this.profile.lineStep;
    return n;
  }
  /** 输出不带行号的注释/程序头 */
  comment(text: string): void {
    this.lines.push(`(${text})`);
  }
  raw(text: string): void {
    this.lines.push(text);
  }
  get currentLine(): number {
    return this.lineNo;
  }
}

export interface NcProgram {
  program_number: string;
  controller_id: string;
  dialect: string;
  post_version: string;
  /** 完整 NC 文本 */
  text: string;
  lines: string[];
  /** 元信息 */
  metadata: {
    ir_id: string;
    job_id: string;
    part_id: string;
    machine_id: string;
    operation_count: number;
    tool_changes: number;
    move_count: number;
    generated_by: string;
    generator_version: string;
    /** P2-20：未知 move type 命中次数（WARN，不抛错） */
    unsupported_move_count: number;
    /** P2-21：冷却代码未映射、静默 fallback M08 的次数（WARN） */
    coolant_fallback_count: number;
    /** P2-32：刀具库版本（无则 "unknown"） */
    tool_library_version: string;
    /** P2-32：材料版本（无则 "unknown"） */
    material_version: string;
    /** P2-32：机床固件版本（无则 "unknown"） */
    machine_firmware: string;
  };
}

// ---------- 坐标输出辅助 ----------
export interface MoveWriter {
  emitMotion(state: ModalState, move: ToolpathMove, feedOverride?: number): string;
  lineForRapid(x: number, y: number, z: number, state: ModalState, profile: ControllerProfile): string;
}

/** 输出"只变化坐标"的轴（模态） */
export function axisBlock(state: ModalState, x?: number, y?: number, z?: number, decimals = 3): string {
  const parts: string[] = [];
  if (x != null && state.lastX !== x) parts.push(`X${fmt(x, decimals)}`);
  if (y != null && state.lastY !== y) parts.push(`Y${fmt(y, decimals)}`);
  if (z != null && state.lastZ !== z) parts.push(`Z${fmt(z, decimals)}`);
  if (x != null) state.lastX = x;
  if (y != null) state.lastY = y;
  if (z != null) state.lastZ = z;
  return parts.join(" ");
}
