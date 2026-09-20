/**
 * Prompt Injection 检测（P5-7）：对 AI 规划的目标文本做注入模式扫描。
 * 检测维度：指令越权 / 提示泄露 / 系统指令覆盖 / 编码与变体绕过。
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

// 模式：不区分大小写；中文/英文关键词
const PATTERNS: Array<{ id: string; severity: InjectionFinding["severity"]; re: RegExp }> = [
  { id: "ignore-instructions", severity: "HIGH", re: /ignore\s+(all|previous|prior|system|above)[^.,;]{0,20}(instructions|rules|prompt|messages)|忽略(以上|所有|先前|之前|系统|上述)*(指令|规则|提示)|无视(指令|规则|提示)/i },
  { id: "system-prompt-reveal", severity: "HIGH", re: /(reveal|show|print|output|display|what\s*is|告诉我|说出|是什么).{0,20}(system\s*prompt|instructions|your\s*prompt|提示词|系统提示|你的指令)/i },
  { id: "role-escalation", severity: "HIGH", re: /now\s+(you\s+are|act\s+as|pretend).{0,20}(admin|god|unrestricted|superuser)|你现在(是|扮演)|解除(限制|约束)|越权/i },
  { id: "bypass-guardrail", severity: "MEDIUM", re: /(bypass|disable|turn\s*off|ignore).{0,20}(guardrail|validation|safety|restriction|limit)|绕过(检查|限制|校验)|跳过(校验|限制)/i },
  { id: "data-exfil", severity: "MEDIUM", re: /(email|send|upload|post|exfiltrate).{0,20}(data|file|code|source|password)|发送.{0,10}(数据|文件|源码|密码)|外传|窃取/i },
  { id: "encoded-variant", severity: "LOW", re: /[a-z]\s*-\s*[a-z]|[\uFF21-\uFF3A]/i },
];

export function checkPromptInjection(text: string): InjectionCheckResult {
  const findings: InjectionFinding[] = [];
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      findings.push({ pattern: p.id, severity: p.severity, snippet: text.slice(Math.max(0, (m.index ?? 0) - 12), Math.min(text.length, (m.index ?? 0) + m[0].length + 12)) });
    }
  }
  return { flagged: findings.some((f) => f.severity !== "LOW"), findings };
}
