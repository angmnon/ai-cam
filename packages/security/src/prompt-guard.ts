/**
 * Prompt Injection 检测（P5-7 / P2-33 增强）：对 AI 规划的目标文本做注入模式扫描。
 * 检测维度：指令越权 / 提示泄露 / 系统指令覆盖 / 编码与变体绕过 /
 *           Unicode 混淆归一化（全角、零宽字符）/ base64 编码指令 / 多轮拼接覆盖。
 */
export interface InjectionFinding {
  pattern: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  snippet: string;
}

export interface InjectionCheckResult {
  flagged: boolean;
  findings: InjectionFinding[];
}

// 既有 6 条正则（P5-7 保留）：不区分大小写；中文/英文关键词
const PATTERNS: Array<{ id: string; severity: InjectionFinding["severity"]; re: RegExp }> = [
  { id: "ignore-instructions", severity: "HIGH", re: /ignore\s+(all|previous|prior|system|above)[^.,;]{0,20}(instructions|rules|prompt|messages)|忽略(以上|所有|先前|之前|系统|上述)*(指令|规则|提示)|无视(指令|规则|提示)/i },
  { id: "system-prompt-reveal", severity: "HIGH", re: /(reveal|show|print|output|display|what\s*is|告诉我|说出|是什么).{0,20}(system\s*prompt|instructions|your\s*prompt|提示词|系统提示|你的指令)/i },
  { id: "role-escalation", severity: "HIGH", re: /now\s+(you\s+are|act\s+as|pretend).{0,20}(admin|god|unrestricted|superuser)|你现在(是|扮演)|解除(限制|约束)|越权/i },
  { id: "bypass-guardrail", severity: "MEDIUM", re: /(bypass|disable|turn\s*off|ignore).{0,20}(guardrail|validation|safety|restriction|limit)|绕过(检查|限制|校验)|跳过(校验|限制)/i },
  { id: "data-exfil", severity: "MEDIUM", re: /(email|send|upload|post|exfiltrate).{0,20}(data|file|code|source|password)|发送.{0,10}(数据|文件|源码|密码)|外传|窃取/i },
  { id: "encoded-variant", severity: "LOW", re: /[a-z]\s*-\s*[a-z]|[\uFF21-\uFF3A]/i },
];

/** P2-33：剥离零宽字符 + NFKC 归一化（全角 ASCII→半角），用于识别混淆变体 */
function normalize(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "").normalize("NFKC");
}

/** 归一化后需命中的注入关键词族（与既有 ignore-instructions 同族，用于全角/零宽变体） */
const UNICODE_VARIANT_RE =
  /ignore\s+(all|previous|prior|above|the)[^.,;]{0,20}(instructions?|rules?|prompt|messages)|忽略(以上|上述|所有|先前|之前)*(指令|规则|提示)|无视(指令|规则|提示)/i;

/** P2-33：长 base64 串（≥16 字符，含 =/+/ /）包裹指令；命中即 flagged */
const BASE64_RE = /[A-Za-z0-9+/]{16,}={0,2}/;

/** P2-33：多轮拼接 —— 元关键词（system prompt/新指令/role/角色）与 忽略/forget/drop 等覆盖词组合出现 */
const MULTITURN_RE =
  /(system\s*prompt|新指令|新的指令|role|角色)\s*[:：]?[^\n]{0,30}?(忽略|forget|drop|overwrite|覆盖|放弃)|(忽略|forget|drop|overwrite|覆盖|放弃)[^\n]{0,30}?(system\s*prompt|新指令|新的指令|role|角色)/i;

function snippetOf(text: string, index: number, len: number): string {
  return text.slice(Math.max(0, index - 12), Math.min(text.length, index + len + 12));
}

export function checkPromptInjection(text: string): InjectionCheckResult {
  const findings: InjectionFinding[] = [];

  // 1) 既有 6 条正则（原文匹配，P5-7 行为不变）
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m && m.index !== undefined) {
      findings.push({ pattern: p.id, severity: p.severity, snippet: snippetOf(text, m.index, m[0].length) });
    }
  }

  // 2) Unicode 变体归一化：仅当原文确有混淆（归一化后文本变化）、归一化后命中注入关键词、
  //    且原文本身未直接命中同族关键词时才报告，避免与既有规则重复、降低误报。
  const norm = normalize(text);
  if (norm !== text) {
    const m = norm.match(UNICODE_VARIANT_RE);
    if (m && !text.match(UNICODE_VARIANT_RE)) {
      findings.push({
        pattern: "unicode-variant",
        severity: "HIGH",
        snippet: text.slice(0, Math.min(text.length, 60)),
      });
    }
  }

  // 3) base64 编码指令：长编码串命中即 flagged
  const bm = text.match(BASE64_RE);
  if (bm && bm.index !== undefined) {
    findings.push({ pattern: "base64-instruction", severity: "MEDIUM", snippet: snippetOf(text, bm.index, bm[0].length) });
  }

  // 4) 多轮拼接覆盖
  const mm = text.match(MULTITURN_RE);
  if (mm && mm.index !== undefined) {
    findings.push({ pattern: "multi-turn-override", severity: "HIGH", snippet: snippetOf(text, mm.index, mm[0].length) });
  }

  return { flagged: findings.some((f) => f.severity !== "LOW"), findings };
}
