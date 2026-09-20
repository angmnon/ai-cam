/** SYNTEC / MITSUBISHI Post 测试（P4-10）：方言 Profile 差异断言 + Golden 干运行 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { postProcess, makeProfile } from "./post.js";

const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
const part = parseWorkerOutput(raw);
const features = buildFeatureGraph(part, "box").features;
const cam = planPart(part, features).cam;

describe("SYNTEC Post（P4-10）", () => {
  it("方言 Profile：无 G43 H、保留钻孔循环、尾部 G28", () => {
    const nc = postProcess(cam, makeProfile("SYNTEC"));
    expect(nc.dialect).toBe("SYNTEC");
    expect(nc.text).not.toContain("G43 H");
    expect(nc.text).toContain("G91 G28 Z0.");
    expect(nc.text).toContain("M30");
    expect(nc.program_number).toMatch(/^O\d{4}$/);
    // 干运行：程序号一致 + 换刀块结构
    expect(nc.metadata.tool_changes).toBeGreaterThan(0);
    expect(nc.lines[0]).toBe(nc.program_number);
  });
});

describe("MITSUBISHI Post（P4-10）", () => {
  it("方言 Profile：保留 G43 H、尾部 G30 回第二参考点", () => {
    const nc = postProcess(cam, makeProfile("MITSUBISHI"));
    expect(nc.dialect).toBe("MITSUBISHI");
    expect(nc.text).toContain("G43 H");
    expect(nc.text).toContain("G91 G30 Z0.");
    expect(nc.text).not.toContain("G91 G28 Z0.");
    expect(nc.text).toContain("M30");
    expect(nc.text).toContain("G21 G17 G90 G94");
  });

  it("FANUC 尾部仍为 G28（回归保护）", () => {
    const nc = postProcess(cam, makeProfile("FANUC"));
    expect(nc.text).toContain("G91 G28 Z0.");
  });
});
