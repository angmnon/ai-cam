#!/usr/bin/env node
// check-migrations.mjs
// 零依赖（仅 node:fs / node:path / node:url）：
// 按文件名顺序扫描 infra/db/migrations/*.sql，提取全部
//   CREATE TABLE [IF NOT EXISTS] <table>
//   REFERENCES <table>(id)
// 按文档顺序（文件间 + 文件内偏移顺序）维护“已创建表”集合，
// 校验每条 REFERENCES 指向的表在该处之前已被 CREATE TABLE 创建。
// 逐项输出 PASS/FAIL 与汇总；存在失败时进程退出码非 0。

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migrationsDir = path.join(repoRoot, 'infra', 'db', 'migrations');

const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
const referencesRe = /REFERENCES\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*id\s*\)/gi;

// 去掉行内 -- 注释，避免注释中的表名被误判（本 schema 字符串字面量不含 --）
function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

function lineAt(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

let files;
try {
  files = fs.readdirSync(migrationsDir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
} catch (err) {
  console.error(`FAIL: 无法读取迁移目录 ${migrationsDir}: ${err.message}`);
  process.exit(2);
}

if (files.length === 0) {
  console.error(`FAIL: 迁移目录为空 ${migrationsDir}`);
  process.exit(2);
}

const created = new Set(); // 已创建的表名（小写），跨文件累积，按文档顺序
let totalTables = 0;
let totalRefs = 0;
let failures = 0;

console.log(`check-migrations: 扫描 ${files.length} 个迁移文件（${path.relative(repoRoot, migrationsDir).replace(/\\/g, '/')}/）\n`);

for (const file of files) {
  const full = path.join(migrationsDir, file);
  const raw = fs.readFileSync(full, 'utf8');
  const sql = stripLineComments(raw);
  console.log(`=== ${file} ===`);

  // 收集本文件内全部 CREATE TABLE 与 REFERENCES 事件，按字符偏移排序
  const events = [];
  let m;

  createTableRe.lastIndex = 0;
  while ((m = createTableRe.exec(sql)) !== null) {
    events.push({ offset: m.index, kind: 'create', table: m[1].toLowerCase() });
  }

  referencesRe.lastIndex = 0;
  while ((m = referencesRe.exec(sql)) !== null) {
    events.push({ offset: m.index, kind: 'ref', table: m[1].toLowerCase() });
  }

  events.sort((a, b) => a.offset - b.offset);

  for (const ev of events) {
    const line = lineAt(sql, ev.offset);
    if (ev.kind === 'create') {
      created.add(ev.table);
      totalTables++;
      console.log(`  [PASS] L${line} CREATE TABLE "${ev.table}"`);
    } else {
      totalRefs++;
      if (created.has(ev.table)) {
        console.log(`  [PASS] L${line} REFERENCES "${ev.table}(id)"`);
      } else {
        failures++;
        console.log(`  [FAIL] L${line} REFERENCES "${ev.table}(id)" —— 该表在此处之前尚未被 CREATE TABLE 创建`);
      }
    }
  }
  console.log('');
}

console.log('--- 汇总 ---');
console.log(`文件数:          ${files.length}`);
console.log(`CREATE TABLE 数: ${totalTables}`);
console.log(`REFERENCES(id):  ${totalRefs}`);
console.log(`失败数:          ${failures}`);

if (failures > 0) {
  console.error(`\n结果: FAIL（${failures} 处外键引用指向尚未创建的表）`);
  process.exit(1);
}

console.log(`\n结果: PASS（全部 ${totalRefs} 处 REFERENCES 均按顺序解析到已创建表）`);
process.exit(0);
