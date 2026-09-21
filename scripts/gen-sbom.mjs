#!/usr/bin/env node
/**
 * P2-38：生成 SPDX 简化格式 SBOM（纯 Node，零依赖）。
 * 扫描 packages 目录下各包的 package.json 与 services/api/package.json 的
 * dependencies / devDependencies，输出仓库根 sbom.json。
 * 用法：node scripts/gen-sbom.mjs（非零退出即 CI 失败）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 收集待扫描的 package.json 路径 */
function collectPackageJson() {
  const files = [];
  const pkgDir = join(root, "packages");
  if (existsSync(pkgDir)) {
    for (const entry of readdirSync(pkgDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pj = join(pkgDir, entry.name, "package.json");
      if (existsSync(pj)) files.push(pj);
    }
  }
  const apiPkg = join(root, "services", "api", "package.json");
  if (existsSync(apiPkg)) files.push(apiPkg);
  return files;
}

function main() {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  const packages = collectPackageJson()
    .map((p) => {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const dependencies = [
        ...Object.keys(j.dependencies ?? {}),
        ...Object.keys(j.devDependencies ?? {}),
      ];
      return { name: j.name ?? p, version: j.version ?? "0.0.0", dependencies };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (packages.length === 0) {
    console.error("[sbom] 未扫描到任何 package.json，失败");
    process.exit(1);
  }

  const sbom = {
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${rootPkg.name ?? "ai-cam"}-sbom`,
    version: rootPkg.version ?? "0.0.0",
    packages,
  };

  const out = join(root, "sbom.json");
  writeFileSync(out, JSON.stringify(sbom, null, 2) + "\n", "utf8");
  console.log(`[sbom] 写入 ${out}：${packages.length} 个 packages`);
}

main();
