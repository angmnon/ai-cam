/**
 * H-2 工厂零件验证批跑：
 * 1) 真实 Golden 零件（tests/golden/parts/*.json，20 件）完整管线 → DFM + CAM + NC（FANUC 校准后）
 * 2) 车间安全流程静态检查（shop-floor-check：空运行/单段/安全高度/程序头尾/Z 下限）
 * 3) 输出 factory-report.json：逐件 PASS/WARN/FAIL + 汇总
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { analyzeDfm } from "@ai-cam/dfm";
import { planPart } from "@ai-cam/cam-kernel";
import { makeProfile, postProcess, defaultCalibration, calibrateProfile } from "@ai-cam/post-core";
import { checkShopFloorNc } from "@ai-cam/shop-floor-check";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PARTS = join(__dirname, "../golden/parts");
const OUT = join(__dirname, "factory-report.json");

function main() {
  const files = readdirSync(GOLDEN_PARTS).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`Golden 零件目录为空: ${GOLDEN_PARTS}`);
  const rows = [];
  for (const file of files) {
    const raw = readFileSync(join(GOLDEN_PARTS, file), "utf8");
    const part = parseWorkerOutput(raw);
    // part_id 从零件文件名真实解析（去掉 .json 后缀），不再硬编码 "box"
    const partId = file.replace(/\.json$/, "");
    const graph = buildFeatureGraph(part, partId);
    const dfm = analyzeDfm(part, graph);
    const plan = planPart(part, graph.features, {});
    const profile = calibrateProfile(makeProfile("FANUC"), defaultCalibration("FANUC"));
    const nc = postProcess(plan.cam, profile);
    const sf = checkShopFloorNc(nc.text, { requirePartComment: true, safeHeightMm: profile.safeHeightMm, minZAllowedMm: -0.6 });
    const blockers = dfm.items.filter((i) => i.severity === "BLOCKER").map((i) => i.code);
    rows.push({
      file,
      features: graph.features.length,
      ops: plan.cam.operations.length,
      dfm_blockers: blockers,
      nc_lines: nc.lines.length,
      shop_floor: { status: sf.status, items: sf.items.map((i) => `${i.code}:${i.severity}`), stats: sf.stats },
      pass: blockers.length === 0 && sf.status !== "FAIL",
    });
  }
  const pass = rows.filter((r) => r.pass).length;
  const report = {
    benchmark: "工厂零件验证（H-2）：真实 Golden 零件 → CAM → NC → 车间安全检查",
    date: new Date().toISOString(),
    total: rows.length,
    pass,
    fail: rows.length - pass,
    pass_rate: Number(((pass / rows.length) * 100).toFixed(2)),
    per_part: rows,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n", "utf8");
  console.log(`=== 工厂零件验证（H-2）===`);
  console.log(`零件 ${pass}/${rows.length} 通过（${report.pass_rate}%）`);
  for (const r of rows) console.log(`  ${r.file}: 特征${r.features} 工序${r.ops} ${r.dfm_blockers.length ? "DFM:" + r.dfm_blockers : ""} 车间${r.shop_floor.status}${r.pass ? "" : " ← FAIL"}`);
  console.log(`报告：tests/factory-validation/factory-report.json`);
}

main();
