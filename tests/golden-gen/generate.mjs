/**
 * H-1 Golden 扩容生成器：程序化生成 300 个分级特征规格样本（100 简单 / 100 中等 / 100 复杂）。
 *
 * 口径（如实）：本数据集为"特征规格级"Golden（零件规格 + 特征对象 + 先验期望），
 * 与 tests/golden/ 下 20 个真实 STEP 实体 Golden 互补；真实 STEP 实体生成依赖 OCCT Worker，
 * 列入 H-2 工厂验证阶段。种子固定 → 输出可复现。
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "../golden-v2");
const SEED = 20260920;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 模板库 ----------
const FEAT_TYPES = ["HOLE_BLIND", "HOLE_THROUGH", "SLOT", "OPEN_POCKET", "POCKET", "STEP", "BOSS", "COUNTERBORE"];
const DIRS = ["+Z", "-Z", "+Y", "-Y", "+X", "-X"];

function rngFeat(rand, base, depthMax) {
  const w = 6 + Math.round(rand() * (base * 0.35));
  const d = 3 + Math.round(rand() * depthMax);
  const holeDia = 4 + Math.round(rand() * 8);
  return { w, d, holeDia };
}

function makeFeature(id, type, base, rand, depthMax, partHeight) {
  const { w, d, holeDia } = rngFeat(rand, base, depthMax);
  const x0 = 8 + Math.round(rand() * 20);
  const y0 = 8 + Math.round(rand() * 20);
  const zH = 8 + Math.round(rand() * 14);
  let bbox, accessible, dims;
  if (type === "HOLE_BLIND" || type === "HOLE_THROUGH" || type === "COUNTERBORE") {
    // 通孔/沉孔必须贯穿零件（z 到零件高）；深径比 ≤ 8 保证 DFM 不阻断
    const holeDepth = type === "HOLE_THROUGH" || type === "COUNTERBORE" ? partHeight : Math.min(d, Math.max(3, partHeight - 2));
    const minDiaForRatio = type === "HOLE_THROUGH" || type === "COUNTERBORE" ? Math.ceil(holeDepth / 8) + 1 : 3;
    const dia = Math.max(type === "COUNTERBORE" ? holeDia + 6 : holeDia, minDiaForRatio);
    bbox = { min: { x: x0, y: y0, z: 0 }, max: { x: x0 + dia, y: y0 + dia, z: holeDepth } };
    accessible = type === "HOLE_THROUGH" || type === "COUNTERBORE" ? ["+Z", "-Z"] : ["+Z"];
    dims = { diameter_mm: dia, depth_mm: holeDepth };
  } else if (type === "SLOT" || type === "OPEN_POCKET" || type === "POCKET") {
    const len = w + 10;
    const depth = Math.min(d, Math.max(3, partHeight - 2));
    bbox = { min: { x: x0, y: y0, z: 0 }, max: { x: x0 + len, y: y0 + w, z: depth } };
    accessible = ["+Z"];
    dims = { width_mm: w, length_mm: len, depth_mm: depth };
  } else if (type === "STEP" || type === "BOSS") {
    const height = Math.min(d, Math.max(3, partHeight - 2));
    bbox = { min: { x: x0, y: y0, z: 0 }, max: { x: x0 + w + 6, y: y0 + w, z: height } };
    accessible = type === "BOSS" ? ["+Z", "+X", "-X", "+Y", "-Y"] : ["+Z"];
    dims = { height_mm: height };
  } else {
    const depth = Math.min(d, Math.max(3, partHeight - 2));
    bbox = { min: { x: x0, y: y0, z: 0 }, max: { x: x0 + w, y: y0 + w, z: depth } };
    accessible = ["+Z"];
    dims = { depth_mm: depth };
  }
  return { id, type, bbox, accessible_directions: accessible, dimensions: dims };
}

const FEAT_OP = { HOLE_BLIND: "DRILL", HOLE_THROUGH: "DRILL", COUNTERBORE: "DRILL", SLOT: "POCKET", OPEN_POCKET: "POCKET", POCKET: "POCKET", STEP: "CONTOUR", BOSS: "CONTOUR" };

function template(level, idx, rand) {
  const base = level === "simple" ? 60 + Math.round(rand() * 40) : 80 + Math.round(rand() * 60);
  const h = level === "simple" ? 20 + Math.round(rand() * 15) : 30 + Math.round(rand() * 25);
  const depthMax = level === "simple" ? 6 : level === "medium" ? 12 : 20;
  const feats = [];
  const kinds =
    level === "simple"
      ? [["HOLE_BLIND"], ["HOLE_THROUGH"], ["SLOT"], ["OPEN_POCKET"], ["POCKET"], ["STEP"], ["BOSS"], ["HOLE_BLIND", "SLOT"]]
      : level === "medium"
        ? [["HOLE_THROUGH", "SLOT", "STEP"], ["POCKET", "BOSS", "HOLE_BLIND"], ["OPEN_POCKET", "HOLE_THROUGH", "STEP"], ["SLOT", "SLOT", "HOLE_BLIND"], ["BOSS", "BOSS", "HOLE_THROUGH"]]
        : [["POCKET", "HOLE_THROUGH", "SLOT", "STEP", "BOSS"], ["COUNTERBORE", "HOLE_BLIND", "SLOT", "OPEN_POCKET", "STEP"], ["HOLE_THROUGH", "HOLE_BLIND", "POCKET", "BOSS", "SLOT", "STEP"]];
  const kindsPick = kinds[Math.floor(rand() * kinds.length)];
  for (let i = 0; i < kindsPick.length; i++) {
    feats.push(makeFeature(`f${i + 1}`, kindsPick[i], base, rand, depthMax, h));
  }
  const w = base;
  const d = base + 30 + Math.round(rand() * 20);
  const vol = w * d * h;
  const faces = [
    { id: 1, type: "PLANE", area_mm2: d * h, bbox: { min: [0, 0, 0], max: [0, d, h] }, normal: [-1, 0, 0], center: [0, 0, 0], edge_count: 4 },
    { id: 2, type: "PLANE", area_mm2: d * h, bbox: { min: [w, 0, 0], max: [w, d, h] }, normal: [1, 0, 0], center: [w, 0, 0], edge_count: 4 },
    { id: 3, type: "PLANE", area_mm2: w * h, bbox: { min: [0, 0, 0], max: [w, 0, h] }, normal: [0, -1, 0], center: [0, 0, 0], edge_count: 4 },
    { id: 4, type: "PLANE", area_mm2: w * h, bbox: { min: [0, d, 0], max: [w, d, h] }, normal: [0, 1, 0], center: [0, d, 0], edge_count: 4 },
    { id: 5, type: "PLANE", area_mm2: w * d, bbox: { min: [0, 0, 0], max: [w, d, 0] }, normal: [0, 0, -1], center: [0, 0, 0], edge_count: 4 },
    { id: 6, type: "PLANE", area_mm2: w * d, bbox: { min: [0, 0, h], max: [w, d, h] }, normal: [0, 0, 1], center: [0, 0, h], edge_count: 4 },
  ];
  return {
    id: `gv2_${level}_${String(idx).padStart(3, "0")}`,
    name: `${level}_${idx}_${kindsPick.join("_").toLowerCase()}`,
    difficulty: level,
    part: { file: `${level}_${idx}.step`, bbox_mm: { min: [0, 0, 0], max: [w, d, h] }, volume_mm3: vol, solid_count: 1, healing_valid: true, face_count: 6 + feats.length, faces },
    features: feats,
    expect: { feature_types: kindsPick, op_types: kindsPick.map((t) => FEAT_OP[t] ?? "CONTOUR"), no_blocker: true },
  };
}

function main() {
  const rand = mulberry32(SEED);
  const specs = [];
  for (const level of ["simple", "medium", "complex"]) {
    for (let i = 1; i <= 100; i++) specs.push(template(level, i, rand));
  }
  const doc = {
    schema_version: "1.0.0",
    generated_by: "golden-gen",
    generated_at: new Date().toISOString(),
    seed: SEED,
    scope_note: "特征规格级 Golden（程序化生成，非 STEP 实体）；与 tests/golden 20 个真实 STEP Golden 互补",
    total: specs.length,
    by_difficulty: { simple: specs.filter((s) => s.difficulty === "simple").length, medium: specs.filter((s) => s.difficulty === "medium").length, complex: specs.filter((s) => s.difficulty === "complex").length },
    sha256: createHash("sha256").update(JSON.stringify(specs)).digest("hex"),
    specs,
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "golden-300.json"), JSON.stringify(doc, null, 1) + "\n", "utf8");
  writeFileSync(join(OUT_DIR, "README.md"), `# Golden v2（300 规格样本）

- 生成器：\`tests/golden-gen/generate.mjs\`（种子 ${SEED}，可复现，sha256=${doc.sha256.slice(0, 16)}…）
- 组成：100 简单 / 100 中等 / 100 复杂，共 300 个特征规格样本
- **口径**：特征规格级（零件规格 + 特征对象 + 先验期望），与 \`tests/golden\` 20 个真实 STEP Golden 互补；
  真实 STEP 实体批量生成依赖 OCCT Worker，列入 Phase 6 H-2。
- 用途：全量回归（\`tests/regression/run-regression.mjs\`）覆盖 DFM/规划/刀路/仿真/后处理/校验的广谱组合。
`, "utf8");
  console.log(`golden-300 生成完成：${specs.length} 件（简单 ${doc.by_difficulty.simple} / 中等 ${doc.by_difficulty.medium} / 复杂 ${doc.by_difficulty.complex}），sha256=${doc.sha256.slice(0, 16)}…`);
}

main();
