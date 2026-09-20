/**
 * Golden 全流程回归（M3 门禁原型）：20 样本 → plan → sim → post → validate 四层。
 * 断言：每个样本 Validated NC（四层无 ERROR）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { postProcess, FANUC_PROFILE } from "@ai-cam/post-core";
import { simulate } from "@ai-cam/stock-sim";
import { validateNc } from "./validator.js";

const PARTS_DIR = resolve(process.cwd(), "../../tests/golden/parts");

function loadStems(): string[] {
  try {
    return readdirSync(PARTS_DIR).filter((f) => f.endsWith(".json")).sort().map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

describe("Golden Validated NC（M3 门禁）", () => {
  const stems = loadStems();
  it("Golden 夹具存在（≥8）", () => expect(stems.length).toBeGreaterThanOrEqual(8));

  for (const stem of stems) {
    it(`${stem}: 全流程 Validated NC PASS`, () => {
      const raw = readFileSync(join(PARTS_DIR, `${stem}.json`), "utf8");
      const part = parseWorkerOutput(raw);
      const { cam } = planPart(part, buildFeatureGraph(part, stem).features);
      const sim = simulate({ cam, partVolumeMm3: part.volume_mm3, frameStep: 4 });
      const nc = postProcess(cam, FANUC_PROFILE);
      const rep = validateNc({ cam, ncText: nc.text, programNumber: nc.program_number, simulation: sim });
      expect(rep.status, `${stem}: ${JSON.stringify(rep.layers.map((l) => ({ layer: l.layer, status: l.status, n: l.checks.length })))}`).toBe("PASS");
    });
  }
});
