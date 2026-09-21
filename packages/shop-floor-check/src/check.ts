/**
 * H-2 工厂零件验证（车间安全流程静态检查）
 * 面向"机上执行前"的安全确认：空运行（G0 快速）、单段（M01）、安全高度、程序头/尾完整性、Z 下限。
 */

/**
 * P2-27：shop-floor-check 最低切削 Z 相对工件底面的安全裕度（mm）。
 * 与 stock-sim 的口径差异（刻意更保守，跨包魔法数统一在此定义）：
 * - stock-sim：allowedBottom 对 DRILL 取 `stockBottom - 0.5`，是"毛坯底 - 0.5"的钻穿容差，
 *   用于仿真判定通孔钻穿是否合规；
 * - shop-floor-check：`FLOOR_CHECK_MIN_Z_OFFSET_MM = -0.6` 是"工件底面 - 0.6"的机上安全裕度，
 *   用于车间静态检查最低切削 Z 是否越界，刻意比 stock-sim 的 -0.5 更保守（多 0.1mm 余量），
 *   避免机上撞底。此处只定义常量与注释，不改数值。
 */
export const FLOOR_CHECK_MIN_Z_OFFSET_MM = -0.6;

/** 括号注释正则（P2-28：原 61-63 行重复出现的 /\(.*\)/ 合并为单一常量）。 */
const PAREN_COMMENT_RE = /\([^)]*\)/;

export interface ShopFloorOptions {
  /** 安全高度（mm），默认 20：切削段不得高于该平面进入空运行 */
  safeHeightMm?: number;
  /** 允许的最低 Z（mm），默认 FLOOR_CHECK_MIN_Z_OFFSET_MM(-0.6)：含过穿余量的工件底面下限 */
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
    // P3-21：合并"地址字母 + 空格 + 带符号数值"（如 "Z -0.5" → "Z-0.5"）。
    // 否则按空白切分时 "-0.5" 会成为独立 token，Z 字只取到裸字母、Number("")=NaN，
    // 最低切削 Z / 模态 Z 全部解析失败。
    .replace(/([a-z])\s+(-?\d)/gi, "$1$2")
    .split(/[\s,]/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
}

function isRapid(w: string): boolean {
  return /^G0$|^G00$/.test(w);
}

export function checkShopFloorNc(ncText: string, options: ShopFloorOptions = {}): ShopFloorReport {
  const o = { safeHeightMm: 20, minZAllowedMm: FLOOR_CHECK_MIN_Z_OFFSET_MM, requirePartComment: false, ...options };
  const lines: Line[] = ncText
    .split(/\r?\n/)
    .map((raw, i) => ({ n: i + 1, raw, words: tokenize(raw) }))
    .filter((l) => l.words.length > 0);
  const items: ShopFloorItem[] = [];
  const program = lines[0]?.words.find((w) => /^O\d+$/.test(w)) ?? lines[0]?.words[0] ?? "";

  // P2-28：原 61-63 行重复正则 /\(.*\)/ 合并为单一 PAREN_COMMENT_RE 复用。
  const firstLine = lines[0]?.raw ?? "";
  const secondLine = ncText.split(/\r?\n/)[1] ?? "";
  const hasComment = PAREN_COMMENT_RE.test(firstLine) || PAREN_COMMENT_RE.test(secondLine);
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
  // P2-28：抬刀检查窗口扩大——记录"从切削状态部分抬刀但尚未到安全高度"的行号。
  // 不再只看单条 G0；允许"部分抬刀 → M01 暂停 → 再抬刀到安全高度"的序列。
  // 只有后续未再抬到安全高度（又进入切削/程序结束）才报 SFC-0103。
  let pendingRetractLine: number | null = null;

  for (const l of lines) {
    const hasG0 = l.words.some(isRapid);
    const hasRapid = hasG0;
    const zWord = l.words.find((w) => w.startsWith("Z"));
    const zVal = zWord ? Number(zWord.slice(1)) : null;
    const prevZModal = zModal;
    if (zVal != null && Number.isFinite(zVal)) zModal = zVal;

    if (l.words.some((w) => /^M01$/.test(w))) m01Count++;

    if (hasG0) {
      rapidCount++;
      // P2-28：从切削状态进入 G0 快速。
      if (inCut) {
        // 快速 Z 向下移动（新 Z < 切削 Z）= 扎刀/未抬刀即快速下降 → 立即判 FAIL
        const rapidDown = zVal != null && Number.isFinite(zVal) && zVal < prevZModal;
        if (rapidDown) {
          items.push({ code: "SFC-0103", severity: "FAIL", message: `空运行 G0 未先抬至安全高度 ${o.safeHeightMm}mm（Z${zModal} 低于切削 Z${prevZModal}，疑似扎刀）`, line: l.n });
          pendingRetractLine = null;
        } else if (zModal < o.safeHeightMm) {
          // 向上部分抬刀但未到安全高度 → 挂起待判定，等待"再抬刀"完成
          if (pendingRetractLine == null) pendingRetractLine = l.n;
        } else {
          // 直接抬到安全高度 → 完整抬刀，清除挂起
          pendingRetractLine = null;
        }
      } else if (zModal >= o.safeHeightMm) {
        // 已在非切削态再抬到安全高度 → 完成抬刀序列
        pendingRetractLine = null;
      }
      inCut = false;
      if (zVal != null) lastRetractZ = zVal;
    } else {
      const isPause = l.words.some((w) => /^M01$/.test(w));
      // P2-28：挂起的部分抬刀后，若又遇到非快速块（切削/其他运动），
      // 但 M01 暂停不关闭窗口（允许"抬刀-暂停-再抬刀"序列）。
      if (pendingRetractLine != null && !isPause) {
        items.push({ code: "SFC-0103", severity: "FAIL", message: `空运行 G0 未完成抬至安全高度 ${o.safeHeightMm}mm（部分抬刀后未再抬刀即继续）`, line: pendingRetractLine });
        pendingRetractLine = null;
      }
      cutCount++;
      inCut = true;
      if (zVal != null) {
        lastCutZ = zVal;
        if (minCutZ == null || zVal < minCutZ) minCutZ = zVal;
      }
    }
  }
  // P2-28：程序结束仍未完成抬刀序列 → 补报
  if (pendingRetractLine != null) {
    items.push({ code: "SFC-0103", severity: "FAIL", message: `空运行 G0 未完成抬至安全高度 ${o.safeHeightMm}mm（程序结束仍未再抬刀）`, line: pendingRetractLine });
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
