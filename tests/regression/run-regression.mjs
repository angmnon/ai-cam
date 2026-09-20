/**
 * H-1 全量回归自动化：对 golden-300（300 特征规格样本）跑 快速层（全部：DFM+规划）
 * + 完整层（每级抽样 20=60：+仿真+后处理+NC 四层校验），输出 regression-report.json。
 *
 * 口径：样本为特征规格级（见 golden-v2/README.md）；回归结果来自真实引擎执行，如实记录 FAIL。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { analyzeDfm } from "@ai-cam/dfm";
import { planPart } from "@ai-cam/cam-kernel";
import { simulate } from "@ai-cam/stock-sim";
import { makeProfile, postProcess } from "@ai-cam/post-core";
import { validateNc } from "@ai-cam/nc-validator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(__dirname, "../golden-v2/golden-300.json");
const OUT = join(__dirname, "regression-report.json");
const FULL_SAMPLE = 20; // 每级完整管线样本数

if (!existsSync(GOLDEN)) throw new Error(`golden-300 缺失，先运行 node tests/golden-gen/generate.mjs: ${GOLDEN}`);
const doc = JSON.parse(readFileSync(GOLDEN, "utf8"));

const FEAT_OP = { HOLE_BLIND: "DRILL", HOLE_THROUGH: "DRILL", COUNTERBORE: "DRILL", SLOT: "POCKET", OPEN_POCKET: "POCKET", POCKET: "POCKET", STEP: "CONTOUR", BOSS: "CONTOUR" };

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[i].toFixed(2));
}

function toPartModel(spec) {
  const b = spec.part.bbox_mm;
  return {
    file: spec.part.file,
    status: "ok",
    units: "mm",
    healing_valid: spec.part.healing_valid,
    solid_count: spec.part.solid_count,
    volume_mm3: spec.part.volume_mm3,
    bbox_mm: { min: b.min, max: b.max },
    face_count: spec.part.face_count,
    faces: spec.part.faces ?? [],
  };
}

function toFeatures(spec) {
  return spec.features.map((f) => ({
    id: f.id,
    type: f.type,
    confidence: 0.95,
    source_face_ids: [],
    bbox: f.bbox,
    accessible_directions: f.accessible_directions,
    dimensions: f.dimensions,
    recognized_by: "GENERATED",
    recognizer_version: "golden-v2-1.0.0",
  }));
}

function runFast(spec) {
  const part = toPartModel(spec);
  const features = toFeatures(spec);
  const dfm = analyzeDfm(part, { part_id: spec.id, features, edges: [], recognizer_version: "golden-v2", created_at: "" });
  const blockers = dfm.items.filter((i) => i.severity === "BLOCKER");
  const plan = planPart(part, features, {});
  const opTypes = new Set(plan.cam.operations.map((o) => o.type));
  const expectedOps = new Set(spec.expect.op_types.map((t) => FEAT_OP[t] ?? t));
  const missing = [...expectedOps].filter((t) => !opTypes.has(t));
  const problems = [];
  if (spec.expect.no_blocker && blockers.length > 0) problems.push(`期望无 BLOCKER，实得 ${blockers.length}（${blockers.map((b) => b.code).join(",")}）`);
  if (missing.length > 0) problems.push(`期望工序类型缺失：${missing.join(",")}（实际 ${[...opTypes].join(",")}）`);
  if (plan.cam.operations.length === 0) problems.push("未生成任何工序");
  return { pass: problems.length === 0, problems, dfm_blockers: blockers.length, op_types: [...opTypes], ops: plan.cam.operations.length, moves: plan.toolpaths.reduce((s, t) => s + t.move_count, 0) };
}

function runFull(spec) {
  const fast = runFast(spec);
  const part = toPartModel(spec);
  const features = toFeatures(spec);
  const plan = planPart(part, features, {});
  const sim = simulate({ cam: plan.cam, partVolumeMm3: part.volume_mm3, voxel: { voxelSize: 3 } });
  const profile = makeProfile("FANUC");
  const nc = postProcess(plan.cam, profile);
  const val = validateNc({ cam: plan.cam, ncText: nc.text, programNumber: nc.program_number, simulation: sim });
  const problems = [...fast.problems];
  if (sim.status === "FAIL") problems.push(`仿真 FAIL（${sim.events} 事件）`);
  if (val.status === "FAIL") problems.push(`NC 校验 FAIL（${val.layers.filter((l) => l.status === "FAIL").map((l) => l.layer).join(",")}）`);
  return { ...fast, pass: fast.pass && sim.status !== "FAIL" && val.status !== "FAIL", problems, sim: sim.status, nc_validator: val.status, nc_lines: nc.lines.length };
}

function main() {
  const t0 = performance.now();
  const rows = [];
  const byLevel = {};
  for (const spec of doc.specs) {
    (byLevel[spec.difficulty] ??= []).push(spec);
  }
  const fullIds = new Set();
  for (const level of Object.keys(byLevel)) {
    byLevel[level].slice(0, FULL_SAMPLE).forEach((s) => fullIds.add(s.id));
  }
  for (const spec of doc.specs) {
    const t = performance.now();
    const full = fullIds.has(spec.id);
    const r = full ? runFull(spec) : runFast(spec);
    rows.push({ id: spec.id, name: spec.name, difficulty: spec.difficulty, full_pipeline: full, pass: r.pass, problems: r.problems, dfm_blockers: r.dfm_blockers, ops: r.ops, moves: r.moves, sim: r.sim ?? "-", nc_validator: r.nc_validator ?? "-", nc_lines: r.nc_lines ?? 0, ms: Number((performance.now() - t).toFixed(1)) });
  }
  const pass = rows.filter((r) => r.pass).length;
  const total = rows.length;
  const fullRows = rows.filter((r) => r.full_pipeline);
  const fastMs = rows.filter((r) => !r.full_pipeline).map((r) => r.ms).sort((a, b) => a - b);
  const fullMs = fullRows.map((r) => r.ms).sort((a, b) => a - b);
  const report = {
    benchmark: "golden-300 全量回归",
    date: new Date().toISOString(),
    total,
    pass,
    fail: total - pass,
    pass_rate: Number(((pass / total) * 100).toFixed(2)),
    sample_note: "快速层=DFM+规划（全部 300）；完整层=+仿真+后处理+NC 四层（每级 20，共 60）",
    difficulty_pass_rate: Object.fromEntries(["simple", "medium", "complex"].map((lv) => [lv, `${rows.filter((r) => r.difficulty === lv && r.pass).length}/100`])),
    perf: {
      fast_p50_ms: pct(fastMs, 50),
      fast_p95_ms: pct(fastMs, 95),
      fast_p99_ms: pct(fastMs, 99),
      full_p50_ms: pct(fullMs, 50),
      full_p95_ms: pct(fullMs, 95),
      full_p99_ms: pct(fullMs, 99),
      wall_sec: Number(((performance.now() - t0) / 1000).toFixed(1)),
    },
    failures: rows.filter((r) => !r.pass).map((r) => ({ id: r.id, difficulty: r.difficulty, problems: r.problems })),
    rows,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n", "utf8");
  console.log(`=== golden-300 全量回归 ===`);
  console.log(`通过 ${pass}/${total}（${report.pass_rate}%）| 简单 ${report.difficulty_pass_rate.simple} · 中等 ${report.difficulty_pass_rate.medium} · 复杂 ${report.difficulty_pass_rate.complex}`);
  console.log(`快速层 P50 ${report.perf.fast_p50_ms}ms / P95 ${report.perf.fast_p95_ms}ms / P99 ${report.perf.fast_p99_ms}ms · 完整层 P50 ${report.perf.full_p50_ms}ms / P95 ${report.perf.full_p95_ms}ms`);
  console.log(`总耗时 ${report.perf.wall_sec}s · 报告：tests/regression/regression-report.json`);
  if (report.failures.length > 0) {
    console.log(`--- 失败明细（${report.failures.length}）---`);
    for (const f of report.failures.slice(0, 15)) console.log(`  ${f.id} [${f.difficulty}] ${f.problems.join("；")}`);
  }
}

main();
