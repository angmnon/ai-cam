/**
 * Golden NC 回归（P3-6 + §10 Post Golden 扩充）：全部 Golden 零件 × 四族 Profile
 * （FANUC / SYNTEC / MITSUBISHI / ISO_GENERIC）→ postProcess。
 * 断言：程序头/行号递增/换刀/主轴/冷却/G 代码语法合法/程序尾 + 各族方言特性。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { postProcess, makeProfile } from "./post.js";
import type { ControllerProfile } from "./core.js";

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

const DIALECTS: Array<{ dialect: ControllerProfile["dialect"]; label: string }> = [
  { dialect: "FANUC", label: "FANUC（G0/G83 族）" },
  { dialect: "SYNTEC", label: "SYNTEC（G0/G83 族）" },
  { dialect: "MITSUBISHI", label: "MITSUBISHI（G00/G83 族）" },
  { dialect: "ISO_GENERIC", label: "ISO 通用（G00/逐行钻孔族）" },
];

function assertDialectFeatures(dialect: ControllerProfile["dialect"], text: string): void {
  switch (dialect) {
    case "FANUC":
      expect(text).toMatch(/G43 H\d+/);
      // P2-22：Z 回零 + X/Y 回零（G28 第一参考点）
      expect(text).toContain("G91 G28 Z0.");
      expect(text).toContain("G28 X0 Y0");
      break;
    case "SYNTEC":
      expect(text).not.toMatch(/G43 H\d+/);
      expect(text).toContain("G91 G28 Z0.");
      expect(text).toContain("G28 X0 Y0");
      break;
    case "MITSUBISHI":
      expect(text).toMatch(/G43 H\d+/);
      // P2-22：三菱用 G30 第二参考点（Z + X/Y）
      expect(text).toContain("G91 G30 Z0.");
      expect(text).toContain("G30 X0 Y0");
      expect(text).not.toContain("G91 G28 Z0.");
      expect(text).not.toContain("G28 X0 Y0");
      break;
    case "ISO_GENERIC":
      expect(text).not.toMatch(/G43 H\d+/);
      // P2-22：ISO 通用同样 G28 回零族
      expect(text).toContain("G91 G28 Z0.");
      expect(text).toContain("G28 X0 Y0");
      break;
  }
}

const knownG = new Set(["G00", "G01", "G02", "G03", "G21", "G17", "G90", "G91", "G94", "G40", "G49", "G80", "G83", "G73", "G28", "G30", "G43", "G41"]);
const knownM = new Set(["M03", "M05", "M06", "M07", "M08", "M09", "M30"]);

for (const { dialect, label } of DIALECTS) {
  describe(`Golden NC 回归（${label}）`, () => {
    const stems = loadStems();
    it("Golden 夹具存在（≥20）", () => expect(stems.length).toBeGreaterThanOrEqual(20));

    for (const stem of stems) {
      it(`${stem}: ${dialect} NC 语法完整且方言正确`, () => {
        const raw = readFileSync(join(PARTS_DIR, `${stem}.json`), "utf8");
        const part = parseWorkerOutput(raw);
        const { cam } = planPart(part, buildFeatureGraph(part, stem).features);
        const nc = postProcess(cam, makeProfile(dialect));

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
          if (g) expect(knownG.has(g[1])).toBe(true);
          const m = M_CODES.exec(l);
          if (m) expect(knownM.has(m[1])).toBe(true);
        }
        // 换刀 ≥ 1
        expect(nc.lines.some((l) => /T\d+ M0?6/.test(l))).toBe(true);
        // 主轴每 op 覆盖
        for (const op of cam.operations) {
          const s = Math.round(op.parameters.spindle_speed_rpm);
          expect(nc.lines.some((l) => new RegExp(`M03 S${s}`).test(l))).toBe(true);
        }
        // 冷却 M08/M09 语义：任一 FLOOD op → 有 M08
        if (cam.operations.some((o) => o.parameters.coolant === "FLOOD")) expect(nc.lines.some((l) => /M08/.test(l))).toBe(true);
        // 无非法数值
        for (const l of nc.lines) expect(l).not.toMatch(/NaN|Infinity/);
        // 尾：M05→M09→M30 顺序，末行 %
        const all = nc.lines.join("\n");
        expect(all).toMatch(/M05[\s\S]*M09[\s\S]*M30/);
        expect(nc.lines[nc.lines.length - 1]).toBe("%");
        // 方言特性
        assertDialectFeatures(dialect, all);
        // P1-07 钻孔循环：含 DRILL 工序且方言声明 drillingCycles → G83 模态 + G80 取消；
        // ISO_GENERIC（drillingCycles=false）保持逐行，不得出现 G83/G73
        const hasDrill = cam.operations.some((o) => o.type === "DRILL");
        if (hasDrill && makeProfile(dialect).drillingCycles) {
          expect(all).toContain("G83");
          expect(all).toContain("G80");
        }
        if (hasDrill && !makeProfile(dialect).drillingCycles) {
          expect(all).not.toContain("G83");
          expect(all).not.toContain("G73");
        }
        // metadata
        expect(nc.metadata.part_id.endsWith(stem)).toBe(true);
        expect(nc.metadata.operation_count).toBe(cam.operations.length);
      });
    }
  });
}
