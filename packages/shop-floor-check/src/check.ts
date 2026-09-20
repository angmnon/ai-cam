/**
 * H-2 工厂零件验证（车间安全流程静态检查）
 * 面向"机上执行前"的安全确认：空运行（G0 快速）、单段（M01）、安全高度、程序头/尾完整性、Z 下限。
 */
export interface ShopFloorOptions {
  /** 安全高度（mm），默认 20：切削段不得高于该平面进入空运行 */
  safeHeightMm?: number;
  /** 允许的最低 Z（mm），默认 -0.6：含过穿余量的毛坯底面下限 */
  minZAllowedMm?: number;
  /** 是否要求程序头含零件名注释 */
  requirePartComment?: boolean;
}

export interface ShopFloorItem {
  code: string;
  severity: "INFO" | "WARN" | "FAIL";
  message: string;
  line: number | null;
}

export interface ShopFloorReport {
  status: "PASS" | "WARN" | "FAIL";
  program: string;
  items: ShopFloorItem[];
  stats: {
    blocks: number;
    rapid_blocks: number;
    cutting_blocks: number;
    m01_blocks: number;
    max_z_retract_mm: number | null;
    min_cut_z_mm: number | null;
  };
}

interface Line { n: number; raw: string; words: string[] }

function tokenize(line: string): string[] {
  const body = line.trim().replace(/^%/, "");
  if (body === "") return [];
  return body
    .replace(/\([^)]*\)/g, " ")
    .replace(/;.*$/, "")
    .split(/[\s,]/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
}

function isRapid(w: string): boolean {
  return /^G0$|^G00$/.test(w);
}

export function checkShopFloorNc(ncText: string, options: ShopFloorOptions = {}): ShopFloorReport {
  const o = { safeHeightMm: 20, minZAllowedMm: -0.6, requirePartComment: false, ...options };
  const lines: Line[] = ncText
    .split(/\r?\n/)
    .map((raw, i) => ({ n: i + 1, raw, words: tokenize(raw) }))
    .filter((l) => l.words.length > 0);
  const items: ShopFloorItem[] = [];
  const program = lines[0]?.words.find((w) => /^O\d+$/.test(w)) ?? lines[0]?.words[0] ?? "";

  const firstLine = lines[0]?.raw ?? "";
  const hasComment = /\(.*\)/.test(firstLine) || /\(.*\)/.test(ncText.split(/\r?\n/)[1] ?? "");
  if (o.requirePartComment && !hasComment) items.push({ code: "SFC-0101", severity: "WARN", message: "程序头缺少零件名/注释", line: 1 });

  // 程序尾
  const last = lines[lines.length - 1];
  const hasEnd = /M30|M02/.test(last?.raw ?? "");
  if (!hasEnd) items.push({ code: "SFC-0102", severity: "FAIL", message: "程序缺少结束码 M30/M02", line: last?.n ?? null });

  // Z 运动与模态状态
  let zModal = 0;
  let lastCutZ: number | null = null;
  let lastRetractZ: number | null = null;
  let inCut = false;
  let m01Count = 0;
  let rapidCount = 0;
  let cutCount = 0;
  let minCutZ: number | null = null;

  for (const l of lines) {
    const hasG0 = l.words.some(isRapid);
    const hasRapid = hasG0;
    const zWord = l.words.find((w) => w.startsWith("Z"));
    const zVal = zWord ? Number(zWord.slice(1)) : null;
    if (zVal != null && Number.isFinite(zVal)) zModal = zVal;

    if (l.words.some((w) => /^M01$/.test(w))) m01Count++;

    if (hasG0 && zModal < o.safeHeightMm && inCut) {
      // 从切削直接进空运行但未先抬到安全高度
      if (lastCutZ != null && zModal < o.safeHeightMm) {
        items.push({ code: "SFC-0103", severity: "FAIL", message: `空运行 G0 未先抬至安全高度 ${o.safeHeightMm}mm（Z${zModal}）`, line: l.n });
      }
    }
    if (hasRapid) {
      rapidCount++;
      inCut = false;
      if (zVal != null) lastRetractZ = zVal;
    } else {
      cutCount++;
      inCut = true;
      if (zVal != null) {
        lastCutZ = zVal;
        if (minCutZ == null || zVal < minCutZ) minCutZ = zVal;
      }
    }
  }

  if (minCutZ != null && minCutZ < o.minZAllowedMm) {
    items.push({ code: "SFC-0104", severity: "FAIL", message: `最低切削 Z${minCutZ}mm 低于允许下限 ${o.minZAllowedMm}mm`, line: null });
  }
  if (rapidCount === 0) items.push({ code: "SFC-0105", severity: "WARN", message: "程序中无 G0 空运行段（可能缺少快速移动）", line: null });
  if (m01Count === 0) items.push({ code: "SFC-0106", severity: "INFO", message: "程序中无 M01 单段暂停（多刀路程序建议使用单段验证）", line: null });
  if (minCutZ != null && minCutZ >= o.safeHeightMm - 1) items.push({ code: "SFC-0107", severity: "WARN", message: "程序未切到毛坯内部（最低切削 Z 高于安全高度）", line: null });

  const status = items.some((i) => i.severity === "FAIL") ? "FAIL" : items.some((i) => i.severity === "WARN") ? "WARN" : "PASS";
  return {
    status,
    program,
    items,
    stats: { blocks: lines.length, rapid_blocks: rapidCount, cutting_blocks: cutCount, m01_blocks: m01Count, max_z_retract_mm: lastRetractZ, min_cut_z_mm: minCutZ },
  };
}
