/**
 * NC 样本导出（Post Golden 语料扩充）：20 个真实 Golden 零件 × 四族 Profile
 * → 引擎真实输出（planPart → postProcess(makeProfile)），写入本目录。
 * 产物命名：sample_{dialect}_{stem}.nc；与手工构造样本（sample_{dialect}_00X.nc）并存。
 * 运行：node tests/golden/nc/generate-nc-samples.mjs（需各包 dist 已构建）
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseWorkerOutput } from "../../../packages/geometry-schema/dist/index.js";
import { buildFeatureGraph } from "../../../packages/feature-engine/dist/index.js";
import { planPart } from "../../../packages/cam-kernel/dist/index.js";
import { postProcess, makeProfile } from "../../../packages/post-core/dist/index.js";

const HERE = resolve(import.meta.dirname ?? process.cwd());
const PARTS_DIR = resolve(HERE, "../parts");
const OUT_DIR = HERE;

const DIALECTS = ["FANUC", "SYNTEC", "MITSUBISHI", "ISO_GENERIC"];

const stems = readdirSync(PARTS_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

if (stems.length < 20) throw new Error(`Golden parts 不足 20（实际 ${stems.length}）`);

let count = 0;
for (const dialect of DIALECTS) {
  for (const stem of stems) {
    const raw = readFileSync(join(PARTS_DIR, `${stem}.json`), "utf8");
    const part = parseWorkerOutput(raw);
    const { cam } = planPart(part, buildFeatureGraph(part, stem).features);
    const nc = postProcess(cam, makeProfile(dialect));
    const fileName = `sample_${dialect.toLowerCase()}_${stem}.nc`;
    writeFileSync(join(OUT_DIR, fileName), nc.lines.join("\n") + "\n", "utf8");
    count++;
  }
}

console.log(`导出完成：${DIALECTS.length} 族 × ${stems.length} 件 = ${count} 段（目录 ${OUT_DIR}）`);
