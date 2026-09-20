/**
 * Golden NC 回归（P3-6 验收）：20 样本 → planPart → postProcess（FANUC + ISO）。
 * 断言：程序头/行号递增/换刀/主轴/冷却/G 代码语法合法/程序尾。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { postProcess, FANUC_PROFILE, ISO_GENERIC_PROFILE } from "./post.js";

const PARTS_DIR = resolve(process.cwd(), "../../tests/golden/parts");

const G_CODES = /^(G\d{2})/;
const M_CODES = /^(M\d{2})/;

function loadStems(): string[] {
  try {
    return readdirSync(PARTS_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

describe("Golden NC 回归（FANUC）", () => {
  const stems = loadStems();
  it("Golden 夹具存在（≥8）", () => expect(stems.length).toBeGreaterThanOrEqual(8));

  for (const stem of stems) {
    it(`${stem}: FANUC NC 语法完整`, () => {
      const raw = readFileSync(join(PARTS_DIR, `${stem}.json`), "utf8");
      const part = parseWorkerOutput(raw);
      const { cam } = planPart(part, buildFeatureGraph(part, stem).features);
      const nc = postProcess(cam, FANUC_PROFILE);

      // 头
      expect(nc.lines[0]).toMatch(/^O\d{4}$/);
      const head = nc.lines.slice(0, 6).join("\n");
      expect(head).toContain("G21 G17 G90 G94");
      expect(head).toContain("G40 G49 G80");
      // 行号严格递增且为整数
      const nums = nc.lines.filter((l) => /^N\d+ /.test(l)).map((l) => Number(/^N(\d+) /.exec(l)![1]));
      for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThan(nums[i - 1]);
      // G/M 代码合法（在已知集合）
      for (const l of nc.lines) {
        const g = G_CODES.exec(l);
        if (g) {
          expect(knownG.has(g[1])).toBe(true);
        }
        const m = M_CODES.exec(l);
        if (m) expect(knownM.has(m[1])).toBe(true);
      }
      // 换刀 ≥ 1
      expect(nc.lines.some((l) => /T\d+ M06/.test(l))).toBe(true);
      // 主轴每 op 覆盖
      for (const op of cam.operations) {
        const s = Math.round(op.parameters.spindle_speed_rpm);
        expect(nc.lines.some((l) => new RegExp(`M03 S${s}`).test(l))).toBe(true);
      }
      // 冷却 M08/M09 语义：任一 FLOOD op → 有 M08
      if (cam.operations.some((o) => o.parameters.coolant === "FLOOD")) expect(nc.lines.some((l) => /M08/.test(l))).toBe(true);
      // 无非法数值
      for (const l of nc.lines) {
        expect(l).not.toMatch(/NaN|Infinity/);
      }
      // 尾：M05→M09→M30 顺序，末行 %
      const all = nc.lines.join("\n");
      expect(all).toMatch(/M05[\s\S]*M09[\s\S]*M30/);
      expect(nc.lines[nc.lines.length - 1]).toBe("%");
      // metadata
      expect(nc.metadata.part_id.endsWith(stem)).toBe(true);
      expect(nc.metadata.operation_count).toBe(cam.operations.length);
    });
  }
});

describe("Golden NC 回归（ISO Generic）", () => {
  const stems = loadStems();
  for (const stem of stems.slice(0, 8)) {
    it(`${stem}: ISO NC 无 G43 且语法合法`, () => {
      const raw = readFileSync(join(PARTS_DIR, `${stem}.json`), "utf8");
      const part = parseWorkerOutput(raw);
      const { cam } = planPart(part, buildFeatureGraph(part, stem).features);
      const nc = postProcess(cam, ISO_GENERIC_PROFILE);
      expect(nc.lines.some((l) => /G43 H\d+/.test(l))).toBe(false);
      expect(nc.lines[0]).toMatch(/^O\d{4}$/);
      expect(nc.lines.join("\n")).toContain("G21 G17 G90 G94");
      for (const l of nc.lines) expect(l).not.toMatch(/NaN|Infinity/);
    });
  }
});

const knownG = new Set(["G00", "G01", "G02", "G03", "G21", "G17", "G90", "G91", "G94", "G40", "G49", "G80", "G28", "G43"]);
const knownM = new Set(["M03", "M05", "M06", "M07", "M08", "M09", "M30"]);
