/**
 * H-6 封闭测试采样：golden-300 抽样 → AI Proposal 存档（JSONL），供种子客户回填 Human Correction。
 * 运行：node tests/beta/beta-sample.mjs [N=20]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planPart } from "@ai-cam/cam-kernel";
import { simulate } from "@ai-cam/stock-sim";
import { makeProfile, postProcess } from "@ai-cam/post-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 20);
const doc = JSON.parse(readFileSync(join(__dirname, "../golden-v2/golden-300.json"), "utf8"));
const seed = (i) => { let x = (i + 1) * 9301 + 49297; return () => { x = (x * 233280 + 9301) % 233280; return x / 233280; }; };

const picked = [];
for (let i = 0; i < N; i++) {
  const r = seed(i);
  const level = ["simple", "medium", "complex"][Math.floor(r() * 3)];
  const pool = doc.specs.filter((s) => s.difficulty === level);
  picked.push(pool[Math.floor(r() * pool.length)]);
}

const records = picked.map((spec, i) => {
  const b = spec.part.bbox_mm;
  const part = { file: spec.part.file, status: "ok", units: "mm", healing_valid: true, solid_count: 1, volume_mm3: spec.part.volume_mm3, bbox_mm: { min: b.min, max: b.max }, face_count: spec.part.face_count, faces: spec.part.faces };
  const features = spec.features.map((f) => ({ id: f.id, type: f.type, confidence: 0.95, source_face_ids: [], bbox: f.bbox, accessible_directions: f.accessible_directions, dimensions: f.dimensions, recognized_by: "GENERATED", recognizer_version: "golden-v2" }));
  const plan = planPart(part, features, {});
  const sim = simulate({ cam: plan.cam, partVolumeMm3: part.volume_mm3 });
  const nc = postProcess(plan.cam, makeProfile("FANUC"));
  return {
    schema_version: "1.0.0",
    record_id: `beta_20260920_${String(i + 1).padStart(4, "0")}`,
    captured_at: new Date().toISOString(),
    tenant_id: "seed_system_generated",
    part: { file: spec.part.file, bbox_mm: b, volume_mm3: spec.part.volume_mm3 },
    ai_proposal: {
      features: spec.features.map((f) => `${f.type} ${f.id}`),
      operations: plan.cam.operations.map((o) => ({ type: o.type, feature_id: o.feature_ids?.[0] ?? "", tool_id: o.tool.tool_id })),
      setups: plan.cam.setups.length,
      sim_status: sim.status,
      nc_lines: nc.lines.length,
    },
    human_correction: null,
    labels: { ai_plan_accepted_ratio: null, correction_kind: [], source: "golden-v2" },
  };
});

const outDir = join(__dirname, "samples");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `beta-corpus-${N}.jsonl`);
writeFileSync(out, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`Beta 采样完成：${N} 条 → ${out}`);
console.log(`样例：${JSON.stringify(records[0].ai_proposal)}`);
