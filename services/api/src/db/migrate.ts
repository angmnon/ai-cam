/**
 * P0-01：按序执行 infra/db/migrations/*.sql（0001~0006）。
 * - 用 _migrations 台账记录已应用文件，重复启动幂等。
 * - 每个迁移在独立事务中执行，失败即回滚该文件并抛出。
 * - 既可在应用启动时调用（runMigrations），也可 `node` 直跑演练（main）。
 * 仅依赖 pg（node-postgres），不引入 ORM / 迁移框架。
 */
import { readdirSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

type Logger = { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };

const consoleLogger: Logger = {
  info: (m, meta) => console.log(`[migrate] ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[migrate] ${m}`, meta ?? ""),
};

/** 从当前文件位置向上找仓库根（含 infra/db/migrations 目录），兼容 src 与 dist 布局 */
export function findMigrationsDir(explicit?: string): string {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  // 边缘/FaaS（Cloudflare Workers / workerd）下 import.meta.url 可能为 undefined，
  // fileURLToPath(undefined) 会抛 TypeError，故需 try/catch 兜底。
  let here = "";
  try {
    here = fileURLToPath(import.meta.url);
  } catch {
    here = "";
  }
  const cwdBase = typeof process !== "undefined" && typeof process.cwd === "function" && typeof process.cwd() === "string" ? process.cwd() : "/";
  let dir = here ? dirname(here) : cwdBase;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "infra", "db", "migrations");
    try {
      readdirSync(candidate).filter((f) => f.endsWith(".sql"));
      return candidate;
    } catch {
      dir = dirname(dir);
    }
  }
  // 兜底：相对 cwd
  return resolve(cwdBase, "infra", "db", "migrations");
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name       TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/** 应用指定目录下全部 .sql 迁移（按文件名排序），返回已应用/跳过清单 */
export async function runMigrations(pool: Pool, options: { dir?: string; logger?: Logger } = {}): Promise<{ applied: string[]; skipped: string[] }> {
  const logger = options.logger ?? consoleLogger;
  // 边缘/FaaS（Cloudflare Workers / workerd）无有效 process.cwd() 也无本地文件系统，
  // 且迁移 SQL 不会打包进 Worker bundle。迁移改由外部一次性执行，此处安全跳过。
  // 注意：workerd 下 process.cwd 可能是“函数但返回 undefined”，故需同时校验返回类型。
  const cwdOk =
    typeof process !== "undefined" &&
    typeof process.cwd === "function" &&
    typeof process.cwd() === "string";
  if (!cwdOk) {
    logger.warn("跳过数据库迁移：运行环境无本地文件系统（边缘/FaaS）。请通过独立脚本对数据库执行迁移。");
    return { applied: [], skipped: [] };
  }
  const dir = findMigrationsDir(options.dir);
  // 边缘/FaaS 无本地文件系统（且迁移 SQL 不会打包进 Worker bundle），无法访问目录时安全跳过。
  let files: string[];
  try {
    mkdirSync(dir, { recursive: true });
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    logger.warn(`跳过数据库迁移：无法访问迁移目录 ${dir}（边缘/FaaS 无文件系统）。请通过独立脚本对数据库执行迁移。`);
    return { applied: [], skipped: [] };
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  const client = await pool.connect();
  try {
    await ensureLedger(client);
    const existing = new Set((await client.query<{ name: string }>("SELECT name FROM _migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (existing.has(file)) {
        logger.info(`skip   ${file}（已应用）`);
        skipped.push(file);
        continue;
      }
      const sql = await import("node:fs/promises").then((fs) => fs.readFile(join(dir, file), "utf8"));
      logger.info(`apply  ${file} ...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
        logger.info(`ok     ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        logger.warn(`FAIL   ${file}`, { error: (err as Error).message });
        throw err;
      }
    }
  } finally {
    client.release();
  }
  logger.info(`迁移完成：应用 ${applied.length} 个，跳过 ${skipped.length} 个。`);
  return { applied, skipped };
}

/** CLI 演练：DATABASE_URL 必须存在；按序打印每步结果 */
export async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL 未设置。真库演练需要连接串（如 postgres://aicam:aicam_dev@localhost:5432/aicam）。");
    process.exit(2);
  }
  const { createPool } = await import("./pool.js");
  const pool = createPool(url);
  try {
    const { applied, skipped } = await runMigrations(pool, { logger: consoleLogger });
    // 健康探针
    const r = await pool.query("SELECT count(*)::int AS n FROM organizations");
    console.log(`[migrate] 连接 OK；organizations 行数=${r.rows[0]?.n}；applied=[${applied.join(", ")}] skipped=[${skipped.join(", ")}]`);
  } finally {
    await pool.end();
  }
}

// `node migrate.ts` 直跑时执行 main；被 import 时不执行
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[migrate] 演练失败：", err);
    process.exit(1);
  });
}
