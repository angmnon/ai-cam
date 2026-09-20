/** post-core 单元测试：格式化 / 模态 / 换刀 / 主轴 / 冷却 / 圆弧 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { postProcess, FANUC_PROFILE, ISO_GENERIC_PROFILE, deriveProgramNumber } from "./post.js";
import { fmt } from "./core.js";

describe("formatter", () => {
  it("fmt 去尾零", () => {
    expect(fmt(3.14, 3)).toBe("3.14");
    expect(fmt(3.0, 3)).toBe("3");
    expect(fmt(-0.0, 3)).toBe("0");
    expect(fmt(52, 3)).toBe("52");
    expect(fmt(1.5, 3)).toBe("1.5");
  });
});

describe("postProcess（box 样本）", () => {
  const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
  const part = parseWorkerOutput(raw);
  const { cam } = planPart(part, buildFeatureGraph(part, "box").features);

  it("程序号确定性派生", () => {
    const a = deriveProgramNumber(cam, "O");
    const b = deriveProgramNumber(cam, "O");
    expect(a).toBe(b);
    expect(a).toMatch(/^O\d{4}$/);
  });

  it("FANUC：头/行号/换刀/主轴/冷却/刀长补偿/尾", () => {
    const nc = postProcess(cam, FANUC_PROFILE);
    const lines = nc.lines;
    expect(lines[0]).toMatch(/^O\d{4}$/);
    expect(lines.join("\n")).toContain("G21 G17 G90 G94");
    expect(lines.join("\n")).toContain("G40 G49 G80");
    // 行号严格递增
    const nums = lines.filter((l) => /^N\d+ /.test(l)).map((l) => Number(/^N(\d+) /.exec(l)![1]));
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    // 换刀
    expect(lines.some((l) => /T\d+ M06/.test(l))).toBe(true);
    // 刀长补偿
    expect(lines.some((l) => /G43 H\d+/.test(l))).toBe(true);
    // 主轴
    const ops = cam.operations;
    for (const op of ops) {
      const s = Math.round(op.parameters.spindle_speed_rpm);
      expect(lines.some((l) => new RegExp(`M03 S${s}`).test(l))).toBe(true);
    }
    // 冷却：首 op FLOOD → M08 存在
    expect(lines.some((l) => /M08/.test(l))).toBe(true);
    // 程序尾
    const tail = lines.slice(-6).join("\n");
    expect(tail).toContain("M05");
    expect(tail).toContain("M30");
    expect(lines[lines.length - 1]).toBe("%");
  });

  it("ISO：无 G43/H，基本语法一致", () => {
    const nc = postProcess(cam, ISO_GENERIC_PROFILE);
    expect(nc.dialect).toBe("ISO_GENERIC");
    expect(nc.lines.some((l) => /G43 H\d+/.test(l))).toBe(false);
    expect(nc.lines.join("\n")).toContain("G21 G17 G90 G94");
    expect(nc.lines[0]).toMatch(/^O\d{4}$/);
  });

  it("metadata 完整性", () => {
    const nc = postProcess(cam, FANUC_PROFILE);
    expect(nc.metadata.part_id.endsWith("box")).toBe(true);
    expect(nc.metadata.operation_count).toBe(cam.operations.length);
    expect(nc.metadata.tool_changes).toBeGreaterThanOrEqual(1);
    expect(nc.metadata.move_count).toBeGreaterThan(0);
    expect(nc.text.length).toBeGreaterThan(200);
  });

  it("坐标绝对值合法（不产生 NaN/非法）", () => {
    const nc = postProcess(cam, FANUC_PROFILE);
    for (const l of nc.lines) {
      expect(l).not.toMatch(/NaN/);
      expect(l).not.toMatch(/Infinity/);
    }
  });
});
