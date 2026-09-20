/**
 * NC Parser（P3-7 Layer 1）：NC 文本 → 结构化行 + 运动点序列。
 * 支持 ISO-6983 子集：N/G/X/Y/Z/I/J/F/S/M/T；模态坐标延续（G01 只给 Z 时沿用 X/Y）。
 */
export interface NcWord {
  code: string; // "N10" / "G00" / "X12.5" ...
  key: string; // "N" / "G" / "X" ...
  value: string;
}

export interface ParsedMotion {
  g: "G00" | "G01" | "G02" | "G03";
  x: number | null;
  y: number | null;
  z: number | null;
  i: number | null;
  j: number | null;
  f: number | null;
  s: number | null;
  t: number | null;
  m: string[];
  lineNo: number;
}

export interface ParsedNc {
  lines: Array<{ lineNo: number; raw: string; words: NcWord[] }>;
  motions: ParsedMotion[];
  /** 模态解析后的运动点序列（含坐标延续） */
  points: Array<{ x: number; y: number; z: number; g: string; lineNo: number }>;
  programNumber: string | null;
  errors: Array<{ lineNo: number; message: string }>;
}

const WORD_RE = /[A-Za-z][+-]?(?:\d+\.?\d*|\.\d+)/g;

export function parseNc(text: string): ParsedNc {
  const out: ParsedNc = { lines: [], motions: [], points: [], programNumber: null, errors: [] };
  let lastX = 0;
  let lastY = 0;
  let lastZ = 0;
  let lastF: number | null = null;

  const rawLines = text.split(/\r?\n/);
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // 注释行 / EOF 标记
    if (trimmed.startsWith("(") || trimmed.startsWith(";") || trimmed === "%") {
      out.lines.push({ lineNo: out.lines.length + 1, raw: trimmed, words: [] });
      continue;
    }
    // 程序号 O1234
    const o = /^O(\d{4})/.exec(trimmed);
    if (o && out.lines.length === 0) {
      out.programNumber = o[1];
      out.lines.push({ lineNo: out.lines.length + 1, raw: trimmed, words: [] });
      continue;
    }
    const words: NcWord[] = [];
    const matches = trimmed.match(WORD_RE) ?? [];
    for (const w of matches) {
      words.push({ code: w, key: w[0].toUpperCase(), value: w.slice(1) });
    }
    if (words.length === 0) {
      out.errors.push({ lineNo: out.lines.length + 1, message: `无法解析行: ${trimmed}` });
      continue;
    }
    const lineNo = out.lines.length + 1;
    out.lines.push({ lineNo, raw: trimmed, words });

    const num = (k: string): number | null => {
      const w = words.find((x) => x.key === k);
      if (!w) return null;
      const v = Number(w.value);
      if (!Number.isFinite(v)) {
        out.errors.push({ lineNo, message: `${k} 值非法: ${w.value}` });
        return null;
      }
      return v;
    };
    const g = words.find((x) => x.key === "G")?.code;
    const motionG: "G00" | "G01" | "G02" | "G03" | null = g && /^G0[0-3]$/.test(g) ? (g as "G00" | "G01" | "G02" | "G03") : null;
    const x = num("X");
    const y = num("Y");
    const z = num("Z");
    if (x != null) lastX = x;
    if (y != null) lastY = y;
    if (z != null) lastZ = z;
    const f = num("F");
    if (f != null) lastF = f;
    if (motionG) {
      const m = words.filter((w) => w.key === "M").map((w) => w.code);
      const s = num("S");
      const t = num("T");
      out.motions.push({ g: motionG, x, y, z, i: num("I"), j: num("J"), f, s, t, m, lineNo });
      out.points.push({ x: lastX, y: lastY, z: lastZ, g: motionG, lineNo });
    }
    // 未知 G/M 检查
    for (const w of words) {
      if (w.key === "G" && !/^G\d{2}$/.test(w.code)) out.errors.push({ lineNo, message: `未知 G 代码: ${w.code}` });
      if (w.key === "M" && !/^M\d{2}$/.test(w.code)) out.errors.push({ lineNo, message: `未知 M 代码: ${w.code}` });
    }
    void lastF;
  }
  return out;
}

/** 运动点序列（忽略程序头尾模态） */
export function motionPoints(nc: ParsedNc): Array<{ x: number; y: number; z: number }> {
  return nc.points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
}
