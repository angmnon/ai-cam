/** nc-validator 单元测试：Parser 语法 / 四层校验 / 分层报告 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { planPart } from "@ai-cam/cam-kernel";
import { postProcess, FANUC_PROFILE } from "@ai-cam/post-core";
import { simulate } from "@ai-cam/stock-sim";
import { parseNc, motionPoints } from "./parser.js";
import { validateNc } from "./validator.js";

describe("parser", () => {
  it("解析 G01 行并做坐标延续", () => {
    const nc = parseNc("N10 G21 G17 G90 G94\nN20 G00 X10. Y20. Z5.\nN30 G01 Z0. F600\nN40 G01 X30.\nN50 M30\n");
    expect(nc.errors).toEqual([]);
    expect(nc.motions.length).toBe(3);
    expect(nc.points[0]).toMatchObject({ x: 10, y: 20, z: 5 });
    expect(nc.points[1]).toMatchObject({ x: 10, y: 20, z: 0 }); // Z 延续 X/Y
    expect(nc.points[2]).toMatchObject({ x: 30, y: 20, z: 0 }); // X 变化 Y/Z 延续
  });

  it("无法解析行报错", () => {
    const nc = parseNc("N10 G01 X10.\nthis is not nc\n");
    expect(nc.errors.length).toBeGreaterThan(0);
  });

  it("P2-24 容忍 G83 固定钻孔循环：循环行/孔位行/取消行均不产生运动点", () => {
    const nc = parseNc(
      "N10 G21 G17 G90 G94\n" +
        "N20 G00 X0. Y0. Z5.\n" + // 运动点 1：快速
        "N30 G83 Z-10. R2. Q2. F100\n" + // 循环调用行：不产点
        "N40 X10. Y10.\n" + // 循环体内模态孔位：不产点
        "N50 X20. Y10.\n" + // 循环体内模态孔位：不产点
        "N60 G80\n" + // 取消循环：不产点
        "N70 G01 X30. Y10. F200\n" + // 运动点 2：直线（Z 延续自循环内 -10）
        "N80 M30\n",
    );
    expect(nc.errors).toEqual([]); // G83/G80/G73 不被当作未知 G
    expect(nc.points.length).toBe(2);
    expect(nc.points[0]).toMatchObject({ x: 0, y: 0, z: 5, g: "G00" });
    expect(nc.points[1]).toMatchObject({ x: 30, y: 10, z: -10, g: "G01" });
  });

  it("P2-24 G81 钻孔循环：循环行/模态孔位/G80 取消均不产点，断言点数与完整点序列", () => {
    const nc = parseNc(
      "N10 G21 G17 G90 G94\n" +
        "N20 G00 X0. Y0. Z5.\n" + // 运动点 1
        "N30 G81 Z-5. R2. F100\n" + // 循环调用行：不产点
        "N40 X10. Y0.\n" + // 模态孔位：不产点
        "N50 X20. Y10.\n" + // 模态孔位：不产点
        "N60 G80\n" + // 取消循环：不产点
        "N70 G01 X30. Y20. F200\n" + // 运动点 2（Z 延续自循环内 -5）
        "N80 M30\n",
    );
    expect(nc.errors).toEqual([]); // G81/G80 不被当作未知 G
    expect(nc.points.length).toBe(2);
    expect(nc.points[0]).toEqual({ x: 0, y: 0, z: 5, g: "G00", lineNo: 2 });
    expect(nc.points[1]).toEqual({ x: 30, y: 20, z: -5, g: "G01", lineNo: 7 });
  });

  it("P2-24 G73 啄钻循环：循环行/模态孔位/G80 取消均不产点，断言点数与完整点序列", () => {
    const nc = parseNc(
      "N10 G21 G17 G90 G94\n" +
        "N20 G00 X0. Y0. Z5.\n" + // 运动点 1
        "N30 G73 Z-20. R2. Q3. F100\n" + // G73 啄钻循环调用行：不产点
        "N40 X5. Y5.\n" + // 模态孔位：不产点
        "N50 G80\n" + // 取消循环：不产点
        "N60 G01 X10. Y10. F200\n" + // 运动点 2（Z 延续自循环内 -20）
        "N70 M30\n",
    );
    expect(nc.errors).toEqual([]); // G73/G80 不被当作未知 G
    expect(nc.points.length).toBe(2);
    expect(nc.points[0]).toEqual({ x: 0, y: 0, z: 5, g: "G00", lineNo: 2 });
    expect(nc.points[1]).toEqual({ x: 10, y: 10, z: -20, g: "G01", lineNo: 6 });
  });
});

describe("validateNc（box 全流程）", () => {
  const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
  const part = parseWorkerOutput(raw);
  const features = buildFeatureGraph(part, "box").features;
  const { cam } = planPart(part, features);
  const sim = simulate({ cam, partVolumeMm3: part.volume_mm3, frameStep: 4 });
  const nc = postProcess(cam, FANUC_PROFILE);

  it("四层全 PASS", () => {
    const rep = validateNc({ cam, ncText: nc.text, programNumber: nc.program_number, simulation: sim });
    expect(rep.schema_version).toBe("1.0.0");
    expect(rep.status).toBe("PASS");
    expect(rep.layers.map((l) => l.layer)).toEqual(["PARSER", "SEMANTIC", "MACHINE", "SIMULATION"]);
    for (const l of rep.layers) expect(l.status).toBe("PASS");
  });

  it("篡改 NC（错误坐标）→ SEMANTIC FAIL", () => {
    const bad = nc.text.replace(/X-4\./g, "X-99.").replace(/X-4/g, "X-99");
    const rep = validateNc({ cam, ncText: bad, programNumber: nc.program_number, simulation: sim });
    expect(rep.status).toBe("FAIL");
    expect(rep.layers.find((l) => l.layer === "SEMANTIC")!.status).toBe("FAIL");
  });

  it("缺少 M30 → SEMANTIC FAIL", () => {
    const bad = nc.text.replace("M30", "M05");
    const rep = validateNc({ cam, ncText: bad, programNumber: nc.program_number, simulation: sim });
    expect(rep.layers.find((l) => l.layer === "SEMANTIC")!.status).toBe("FAIL");
  });

  it("P1-08 不传 simulation → L4 仿真门禁 FAIL（整体 FAIL）", () => {
    const rep = validateNc({ cam, ncText: nc.text, programNumber: nc.program_number });
    expect(rep.status).toBe("FAIL");
    const l4 = rep.layers.find((l) => l.layer === "SIMULATION")!;
    expect(l4.status).toBe("FAIL");
    expect(l4.checks.some((c) => c.code === "SIM_NOT_PROVIDED" && c.severity === "ERROR")).toBe(true);
  });

  it("P1-09 RAPID 错写为 G01 → SEMANTIC FAIL（MOTION_TYPE_MISMATCH）", () => {
    // 把第一个 G00 快速定位错写成 G01（坐标/点数不变，仅 G 代码类型错）
    const bad = nc.text.replace("G00", "G01");
    expect(bad).not.toBe(nc.text);
    const rep = validateNc({ cam, ncText: bad, programNumber: nc.program_number, simulation: sim });
    expect(rep.status).toBe("FAIL");
    const l2 = rep.layers.find((l) => l.layer === "SEMANTIC")!;
    expect(l2.status).toBe("FAIL");
    expect(l2.checks.some((c) => c.code === "MOTION_TYPE_MISMATCH")).toBe(true);
  });

  it("NC 运动点与 IR 完全一致", () => {
    const parsed = parseNc(nc.text);
    const ncPts = motionPoints(parsed);
    const irPts: Array<{ x: number; y: number; z: number }> = [];
    for (const op of cam.operations) {
      const tp = cam.toolpaths!.find((t) => t.operation_id === op.id)!;
      for (const m of tp.moves) irPts.push({ x: m.x, y: m.y, z: m.z });
    }
    expect(ncPts.length).toBe(irPts.length);
    for (let i = 0; i < ncPts.length; i++) {
      expect(Math.hypot(ncPts[i].x - irPts[i].x, ncPts[i].y - irPts[i].y, ncPts[i].z - irPts[i].z)).toBeLessThan(1e-2);
    }
  });

  it("P2-25 ① 代码行含 M03 S<rpm> → 主轴校验通过（无 SPINDLE_MISMATCH）", () => {
    const rep = validateNc({ cam, ncText: nc.text, programNumber: nc.program_number, simulation: sim });
    const l2 = rep.layers.find((l) => l.layer === "SEMANTIC")!;
    expect(l2.checks.some((c) => c.code === "SPINDLE_MISMATCH")).toBe(false);
  });

  it("P2-25 ② 无 M03/M04（改为 M05）→ SPINDLE_MISMATCH 报错", () => {
    const bad = nc.text.replace(/M03 S\d+/g, "M05"); // 两处主轴行都去掉 M03/M04
    expect(bad).not.toBe(nc.text);
    const rep = validateNc({ cam, ncText: bad, programNumber: nc.program_number, simulation: sim });
    const l2 = rep.layers.find((l) => l.layer === "SEMANTIC")!;
    expect(l2.checks.filter((c) => c.code === "SPINDLE_MISMATCH").length).toBeGreaterThan(0);
  });

  it("P2-25 ③ M03 S<rpm> 写在行内括号注释里 → 不计命中，SPINDLE_MISMATCH 报错", () => {
    // 把主轴行改为注释形式：N30 M03 S5968  →  N30 (M03 S5968)
    const bad = nc.text.replace(/M03 S\d+/g, (m) => `(${m})`);
    expect(bad).not.toBe(nc.text);
    const rep = validateNc({ cam, ncText: bad, programNumber: nc.program_number, simulation: sim });
    const l2 = rep.layers.find((l) => l.layer === "SEMANTIC")!;
    // 注释里的 M03/S 不应被识别 → 每个 op 都报 SPINDLE_MISMATCH
    expect(l2.checks.filter((c) => c.code === "SPINDLE_MISMATCH").length).toBeGreaterThan(0);
  });

  it("P2-26 machine 不在种子库 → L3 report 含 MACHINE_NOT_IN_SEED WARN（不再静默降级）", () => {
    // 把 machine_id 改成种子库中不存在的值，强制 L3 走降级分支
    const unknownCam = { ...cam, machine: { ...cam.machine, machine_id: "m_unknown_seed_machine" } };
    const rep = validateNc({ cam: unknownCam, ncText: nc.text, programNumber: nc.program_number, simulation: sim });
    const l3 = rep.layers.find((l) => l.layer === "MACHINE")!;
    const warn = l3.checks.find((c) => c.code === "MACHINE_NOT_IN_SEED");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("WARN");
    expect(l3.status).toBe("WARN");
  });
});
