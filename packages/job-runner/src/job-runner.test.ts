/** job-runner 测试：box 全流程一键 Validated NC */
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkerOutput } from "@ai-cam/geometry-schema";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { runJob } from "./run.js";

/**
 * P1-11/P1-12 编排层单测：默认走真实 simulate；用例内通过 sim.override
 * 一次性把真实仿真报告改写为 WARN / FAIL，验证双门禁与短路逻辑。
 * golden box 唯一关键面残料恒为 0，无法靠阈值在真实几何上造出非 PASS，故用此注入。
 */
const sim = vi.hoisted(() => ({
  override: null as null | ((real: any) => any),
}));
vi.mock("@ai-cam/stock-sim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-cam/stock-sim")>();
  return {
    ...actual,
    simulate: (input: never) => {
      const real = actual.simulate(input as never);
      return sim.override ? sim.override(real) : real;
    },
  };
});

/**
 * P2-29 POST 阶段校验：默认走真实 postProcess；用例内通过 post.override
 * 把真实 NC 文本改写为空字符串/空行，验证 POST=FAIL 且 VALIDATE 短路。
 */
const post = vi.hoisted(() => ({
  override: null as null | ((real: any) => any),
}));
vi.mock("@ai-cam/post-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-cam/post-core")>();
  return {
    ...actual,
    postProcess: (...args: unknown[]) => {
      const real = actual.postProcess(...(args as Parameters<typeof actual.postProcess>));
      return post.override ? post.override(real) : real;
    },
  };
});

describe("runJob（box）", () => {
  const raw = readFileSync(join(process.cwd(), "../../tests/golden/parts/box.json"), "utf8");
  const part = parseWorkerOutput(raw);
  const features = buildFeatureGraph(part, "box").features;

  afterEach(() => {
    sim.override = null;
    post.override = null;
  });

  it("一键生成 Validated NC", () => {
    const job = runJob({ part, partName: "box", features });
    expect(job.validated).toBe(true);
    expect(job.pipeline.map((p) => p.stage)).toEqual(["PLAN", "SIMULATE", "POST", "VALIDATE"]);
    for (const p of job.pipeline) expect(p.status).toBe("PASS");
    expect(job.nc).not.toBeNull();
    expect(job.nc!.program_number).toMatch(/^O\d{4}$/);
    expect(job.simulation.status).toBe("PASS");
    expect(job.validation).not.toBeNull();
    expect(job.validation!.status).toBe("PASS");
    expect(job.cam.part_id.endsWith("box")).toBe(true);
  });

  it("ISO 方言可选", () => {
    const job = runJob({ part, partName: "box", features, dialect: "ISO_GENERIC" });
    expect(job.nc!.dialect).toBe("ISO_GENERIC");
    expect(job.validated).toBe(true);
  });

  it("P1-11：仿真 WARN 时 validated=false（严格双门禁，WARN 不放行）", () => {
    sim.override = (real) => ({
      ...real,
      status: "WARN",
      events: [...real.events, { kind: "RESIDUAL_WARN", severity: "WARN", x: 0, y: 0, z: 0, message: "注入测试 WARN" }],
    });
    const job = runJob({ part, partName: "box", features });
    expect(job.simulation.status).toBe("WARN");
    // 关键断言：WARN 即不放行（旧口径 !== "FAIL" 会误放行）
    expect(job.validated).toBe(false);
    expect(job.reason).toMatch(/未达 NC_READY/);
  });

  it("P1-12：仿真 FAIL 时短路，不生成 NC，POST/VALIDATE 标记 SKIPPED", () => {
    sim.override = (real) => ({
      ...real,
      status: "FAIL",
      events: [...real.events, { kind: "COLLISION", severity: "FAIL", x: 0, y: 0, z: 0, message: "注入测试 FAIL" }],
    });
    const job = runJob({ part, partName: "box", features });
    expect(job.simulation.status).toBe("FAIL");
    // 短路：NC 未生成、校验未执行
    expect(job.nc).toBeNull();
    expect(job.validation).toBeNull();
    expect(job.validated).toBe(false);
    expect(job.reason).toMatch(/仿真 FAIL/);
    // 流水线仍记录四阶段，但 POST/VALIDATE 为 SKIPPED
    expect(job.pipeline.map((p) => p.stage)).toEqual(["PLAN", "SIMULATE", "POST", "VALIDATE"]);
    const post = job.pipeline.find((p) => p.stage === "POST")!;
    const validate = job.pipeline.find((p) => p.stage === "VALIDATE")!;
    expect(post.status).toBe("SKIPPED");
    expect(validate.status).toBe("SKIPPED");
  });

  it("P2-29：POST 输出空文本时 POST=FAIL，VALIDATE 短路 SKIPPED", () => {
    // mock post 输出空字符串：text 为空、无任何行
    post.override = (real) => ({ ...real, text: "", lines: [] });
    const job = runJob({ part, partName: "box", features });
    expect(job.pipeline.map((p) => p.stage)).toEqual(["PLAN", "SIMULATE", "POST", "VALIDATE"]);
    const postStage = job.pipeline.find((p) => p.stage === "POST")!;
    const validateStage = job.pipeline.find((p) => p.stage === "VALIDATE")!;
    expect(postStage.status).toBe("FAIL");
    expect(validateStage.status).toBe("SKIPPED");
    expect(job.validated).toBe(false);
    expect(job.reason).toMatch(/POST 阶段失败/);
    expect(job.validation).toBeNull();
    expect(job.nc!.text).toBe("");
  });

  it("P2-29：POST 仅含空白行时仍判 POST=FAIL（至少 1 行非空）", () => {
    post.override = (real) => ({ ...real, text: "   \n\t\n", lines: ["   ", "\t"] });
    const job = runJob({ part, partName: "box", features });
    const postStage = job.pipeline.find((p) => p.stage === "POST")!;
    expect(postStage.status).toBe("FAIL");
    expect(job.validated).toBe(false);
  });
});
