/**
 * H-3 Post 校准：真实机床参数化校准表 + 应用到 ControllerProfile。
 * 每个控制器族提供"出厂默认校准"，可被特定机床（型号/序号）覆盖。
 */
import type { ControllerProfile } from "./core.js";

export interface PostCalibration {
  /** 校准目标：控制器族 */
  dialect: "FANUC" | "SYNTEC" | "MITSUBISHI" | "ISO_GENERIC";
  /** 可选：具体机床型号（为空表示族默认） */
  machine_model?: string;
  /** 快速移动字（FANUC/SYNTEC=G0，MITSUBISHI=G00） */
  rapidWord: string;
  /** 默认安全高度（mm），程序头抬刀与空运行前抬刀使用 */
  safeHeightMm: number;
  /** 程序头模板（{program} 程序号、{part} 零件名、{machine} 机床型号） */
  programHeaderTemplate: string;
  /** 换刀输出（{tool} 刀号） */
  toolChangeTemplate: string;
  /** 默认进给（mm/min），无进给时兜底 */
  defaultFeedMmMin: number;
  /** 钻孔循环（FANUC=G83 啄钻 / SYNTEC=G73 高速啄钻 / MITSUBISHI=G83） */
  drillCycle: "G81" | "G83" | "G73";
  /** 啄钻每次进给深度（mm） */
  peckIncrementMm: number;
}

const DEFAULTS: Record<string, Omit<PostCalibration, "dialect" | "machine_model">> = {
  FANUC: { rapidWord: "G0", safeHeightMm: 20, programHeaderTemplate: "O{program} ({part})", toolChangeTemplate: "T{tool} M06", defaultFeedMmMin: 800, drillCycle: "G83", peckIncrementMm: 2.5 },
  SYNTEC: { rapidWord: "G0", safeHeightMm: 25, programHeaderTemplate: "O{program} ({part})", toolChangeTemplate: "T{tool} M6", defaultFeedMmMin: 750, drillCycle: "G73", peckIncrementMm: 3 },
  MITSUBISHI: { rapidWord: "G00", safeHeightMm: 25, programHeaderTemplate: "O{program} ({part})", toolChangeTemplate: "T{tool} M06", defaultFeedMmMin: 700, drillCycle: "G83", peckIncrementMm: 2 },
  ISO_GENERIC: { rapidWord: "G00", safeHeightMm: 25, programHeaderTemplate: "O{program} ({part})", toolChangeTemplate: "T{tool} M06", defaultFeedMmMin: 800, drillCycle: "G83", peckIncrementMm: 2.5 },
};

export function defaultCalibration(dialect: PostCalibration["dialect"]): PostCalibration {
  const d = DEFAULTS[dialect];
  if (!d) throw new Error(`未知控制器族: ${dialect}`);
  return { dialect, ...d };
}

export function calibrateProfile(profile: ControllerProfile, calibration: PostCalibration): ControllerProfile {
  if (profile.dialect !== calibration.dialect) {
    throw new Error(`校准方言 ${calibration.dialect} 与 profile ${profile.dialect} 不匹配`);
  }
  // 校准以显式字段并入 profile（不改变现有输出语义的字段原样保留）
  return {
    ...profile,
    capabilities: [...profile.capabilities, "CALIBRATED"],
    rapidWord: calibration.rapidWord,
    safeHeightMm: calibration.safeHeightMm,
    programHeaderTemplate: calibration.programHeaderTemplate,
    toolChangeTemplate: calibration.toolChangeTemplate,
    defaultFeedMmMin: calibration.defaultFeedMmMin,
    drillCycle: calibration.drillCycle,
    peckIncrementMm: calibration.peckIncrementMm,
  };
}

export type { ControllerProfile };
