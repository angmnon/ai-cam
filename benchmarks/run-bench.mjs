/**
 * P5-8 性能基准建档：对 golden box 零件跑 解析→特征→刀路→仿真→后处理 全链路，
 * 每阶段重复 N 轮计时，输出 P50/P95/P99（ms）到 results.json（可复现，提交建档）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { simulate } from "@ai-cam/stock-sim";
import { makeProfile, postProcess } from "@ai-cam/post-core";
import { camIrHash } from "@ai-cam/cam-ir";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPEATS = 30;

function pct(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const i = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return Number(sortedMs[i].toFixed(2));
}

function bench(name, fn) {
  const samples = [];
  let last;
  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    last = fn();
    samples.push(performance.now() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { stage: name, runs: REPEATS, p50_ms: pct(sorted, 50), p95_ms: pct(sorted, 95), p99_ms: pct(sorted, 99), min_ms: Number(sorted[0].toFixed(2)), max_ms: Number(sorted[sorted.length - 1].toFixed(2)), digest: last };
}

const rawPath = join(__dirname, "../tests/golden/parts/box.json");
if (!existsSync(rawPath)) throw new Error(`golden box 缺失: ${rawPath}`);
const raw = readFileSync(rawPath, "utf8");

const results = [];
results.push(bench("parse(STEP→规范化)", () => parseWorkerOutput(raw)));
let part;
results.push(
  bench("feature-graph(特征识别)", () => {
    part = parseWorkerOutput(raw);
    return buildFeatureGraph(part, "box").features.length;
  }),
);
let cam;
results.push(
  bench("cam-plan(刀路生成)", () => {
    const p = parseWorkerOutput(raw);
    const feats = buildFeatureGraph(p, "box").features;
    cam = planPart(p, feats, {});
    return `${cam.cam.operations.length}ops/${cam.toolpaths.reduce((s, t) => s + t.move_count, 0)}moves`;
  }),
);
results.push(
  bench("stock-sim(仿真)", () => {
    const sim = simulate({ cam: cam.cam, partVolumeMm3: 800 * 500 * 300, voxel: { resolution: 2 } });
    return `${sim.status}:${sim.events}`;
  }),
);
results.push(
  bench("post(后处理FANUC)", () => {
    const profile = makeProfile("FANUC");
    const out = postProcess(cam.cam, profile);
    return out.lines.length;
  }),
);

const report = {
  benchmark: "ai-cam P5-8 性能建档",
  date: new Date().toISOString(),
  hardware_note: "本机实跑（未标注机型）",
  repeats: REPEATS,
  part: "tests/golden/parts/box.json",
  cam_hash: cam ? camIrHash(cam.cam) : "",
  stages: results.map(({ digest, ...r }) => r),
};
writeFileSync(join(__dirname, "results.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
for (const r of results) {
  console.log(`${r.stage.padEnd(22)} p50=${r.p50_ms}ms p95=${r.p95_ms}ms p99=${r.p99_ms}ms  [${r.digest}]`);
}
console.log(`建档: benchmarks/results.json (cam_hash=${report.cam_hash.slice(0, 12)}…)`);
