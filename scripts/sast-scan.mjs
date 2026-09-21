#!/usr/bin/env node
/**
 * P1-02 零依赖 SAST 扫描器（CodeQL CLI 本机未安装，先用本脚本做启发式静态扫描）。
 *
 * 扫描目标：services/api/src 与 packages 下各包 src 目录（.ts/.mjs/.js，排除 dist/node_modules/test）。
 * 检测类别：
 *   RCE        eval( / new Function(
 *   CHILD_PROC  child_process 的 exec(（非 execFile/execFileSync/spawn）
 *   REDOS      正则字面量中的嵌套量词（(a+)+ / (.*)* 类灾难性回溯模式）
 *   SQL_CONCAT SQL 字符串内的 ${} / + 插值（参数化 $1 不算）
 *   WEAK_RANDOM 安全场景使用 Math.random()（auth/token/session/secret/key 相关文件）
 *   PATH_TRAV  文件系统 API 使用拼接路径且未见 ".." 拒绝/归一化校验
 *
 * 纯启发式，可能误报/漏报；输出 file:line 报告，供人工复核。
 * 用法：node scripts/sast-scan.mjs [--json] [--strict]
 *   --json    机器可读 JSON 输出
 *   --strict  存在 HIGH 命中时以 exit 1 退出（默认 exit 0，仅出报告）
 * 与 ESLint 互补：本脚本专注安全模式，ESLint 负责风格/通用 bug。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const strict = args.has("--strict");

const SCAN_DIRS = ["services/api/src", "packages"];
const SKIP_DIR_SEGMENTS = new Set(["node_modules", "dist", "build", ".turbo", ".next", "coverage", "lib", "esm"]);
const SRC_EXT = new Set([".ts", ".mts", ".mjs", ".js", ".cjs"]);
const TEST_FILE = /(\.test\.|\.spec\.|integration\.test\.)/;

/** 递归收集待扫描源文件 */
function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIR_SEGMENTS.has(name)) continue;
      // packages/<pkg>/dist 已跳过；packages/<pkg> 下只扫 src，避免扫 examples/tools
      collectFiles(full, out);
    } else if (st.isFile()) {
      if (!SRC_EXT.has((name.match(/\.[^.]+$/)?.[0] ?? ""))) continue;
      if (TEST_FILE.test(name)) continue;
      out.push(full);
    }
  }
  return out;
}

const SQL_KEYWORDS = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|WHERE|VALUES|SET)\b/; // 大小写敏感：本仓 SQL 动词均大写，避免变量名 from/update 误报

/** 逐文件正则启发式，返回 findings */
function scanFile(file, relPath) {
  const findings = [];
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return findings;
  }
  const lines = text.split(/\r?\n/);
  const usesChildProcess = /(from\s+["']node:child_process["']|require\(["']child_process["']\))/.test(text);
  const isSecurityCtx = /(auth|token|session|secret|crypto|credential|login|jwt)/i.test(file);

  // 预收集文件内是否存在路径归一化/穿越校验
  const hasTraversalGuard = /"\.\."|'\.\.'|\bnormalize\b|\bresolve\b|\brelative\b|pathTraversal|traversal/i.test(text);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const t = line;

    // 1) RCE：eval( / new Function(
    if (/\beval\s*\(/.test(t) || /new\s+Function\s*\(/.test(t)) {
      findings.push({ rule: "RCE", severity: "HIGH", file: relPath, line: lineNo, snippet: t.trim() });
    }

    // 2) child_process exec（非 execFile）
    if (usesChildProcess && /\bexec\s*\(/.test(t) && !/\bexec(File|Sync)/.test(t)) {
      findings.push({ rule: "CHILD_PROC", severity: "HIGH", file: relPath, line: lineNo, snippet: t.trim() });
    }

    // 3) ReDoS 嵌套量词：( ... 内含量词 ... ) 后再跟量词
    if (/\([^()]*[+*][^()]*\)[+*{]/.test(t) || /\(\?[:=!]?[^()]*[+*][^()]*\)[+*{]/.test(t)) {
      findings.push({ rule: "REDOS", severity: "MEDIUM", file: relPath, line: lineNo, snippet: t.trim() });
    }

    // 4) SQL 拼接：含大写 SQL 关键字的模板字符串里出现 ${} 插值（参数化 $N 不算）
    if (SQL_KEYWORDS.test(t) && /`[^`]*\$\{/.test(t)) {
      // 排除：${params.length} 类占位符编号（生成 $1/$2，非用户输入插值）
      if (/\$\{\s*params\.length\s*\}/.test(t)) {
        // 不计为发现
      } else {
        // 排除纯标识符拼接（where.join / 列名片段）——含标识符片段时降级 LOW
        const looksDynamicIdent = /\$\{\s*(where|cols|order|sort|fields|select|table|column|countWhere|SELECT_WITH)/i.test(t);
        findings.push({
          rule: "SQL_CONCAT",
          severity: looksDynamicIdent ? "LOW" : "MEDIUM",
          file: relPath,
          line: lineNo,
          snippet: t.trim(),
        });
      }
    }

    // 5) 安全场景弱随机 Math.random()
    if (isSecurityCtx && /\bMath\.random\s*\(/.test(t)) {
      findings.push({ rule: "WEAK_RANDOM", severity: "MEDIUM", file: relPath, line: lineNo, snippet: t.trim() });
    }

    // 6) 路径穿越：fs 写/读 API 使用 join/拼接路径，且文件未见穿越防护
    if (!hasTraversalGuard && /\b(writeFile|readFile|mkdir|readdir|createReadStream|createWriteStream)\s*\(/.test(t) && /(join|resolve|\$\{|\+)/.test(t)) {
      findings.push({ rule: "PATH_TRAV", severity: "MEDIUM", file: relPath, line: lineNo, snippet: t.trim() });
    }
  });

  return findings;
}

// ---- 主流程 ----
const files = SCAN_DIRS.flatMap((d) => collectFiles(resolve(repoRoot, d)));
const all = files.flatMap((f) => scanFile(f, relative(repoRoot, f).replaceAll(sep, "/")));

const byRule = {};
for (const f of all) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
const highCount = all.filter((f) => f.severity === "HIGH").length;

if (asJson) {
  console.log(JSON.stringify({ files_scanned: files.length, counts: byRule, findings: all }, null, 2));
} else {
  console.log(`[sast] 扫描文件数=${files.length}（services/api/src + packages/*/src）`);
  if (all.length === 0) {
    console.log("[sast] 未命中任何启发式规则。");
  } else {
    console.log(`[sast] 命中 ${all.length} 条（HIGH=${highCount}）：`);
    for (const f of all) {
      console.log(`  ${f.rule.padEnd(12)} [${f.severity.padEnd(6)}] ${f.file}:${f.line}  ${f.snippet.slice(0, 110)}`);
    }
    console.log("[sast] 规则分布: " + Object.entries(byRule).map(([k, v]) => `${k}=${v}`).join(", "));
  }
}

if (strict && highCount > 0) {
  process.exit(1);
}
