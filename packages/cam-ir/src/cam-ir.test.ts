import { describe, expect, it } from "vitest";
import { makeChangeSet } from "./change-set.js";
import { CAM_IR_SCHEMA_VERSION, CamIR, camIrHash, canonicalJson } from "./schema.js";
import { validateCamIR } from "./validator.js";

function baseIR(): CamIR {
  return {
    schema_version: CAM_IR_SCHEMA_VERSION,
    ir_id: "ir_1",
    job_id: "job_1",
    part_id: "part_1",
    units: { length: "mm", angle: "deg", speed: "rpm", feed: "mm/min" },
    machine: {
      machine_id: "m_vmc_3axis",
      controller_id: "c_fanuc",
      axis_config: "3AXIS",
      max_spindle_rpm: 12000,
    },
    material: { material_id: "mat_6061", grade: "T6" },
    stock: { id: "stock_1", kind: "BOX", dimensions: { x: 100, y: 80, z: 40 } },
    setups: [{ id: "s1", wcs: "G54", origin: { x: 0, y: 0, z: 0 } }],
    tools: [{ tool_id: "t_em10" }],
    operations: [
      {
        id: "op1",
        op_index: 1,
        type: "FACE",
        setup_id: "s1",
        feature_ids: ["f1"],
        tool: { tool_id: "t_em10" },
        parameters: { spindle_speed_rpm: 8000, feed_mm_min: 1200, stepdown_mm: 2, coolant: "FLOOD", source: "ENGINE" },
        depends_on: [],
      },
      {
        id: "op2",
        op_index: 2,
        type: "POCKET",
        setup_id: "s1",
        feature_ids: ["f2"],
        tool: { tool_id: "t_em10" },
        parameters: { spindle_speed_rpm: 7000, feed_mm_min: 900, stepdown_mm: 1, coolant: "FLOOD", source: "ENGINE" },
        depends_on: ["op1"],
      },
    ],
    metadata: { generated_by: "test", generator_version: "0.0.0", created_at: "2026-09-20T00:00:00Z" },
  };
}

describe("cam-ir", () => {
  it("合法 IR 通过校验并生成 hash", () => {
    const res = validateCamIR(baseIR());
    expect(res.ok).toBe(true);
    expect(res.issues).toHaveLength(0);
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("非法 schema 被拒绝", () => {
    const bad = { ...baseIR(), schema_version: "9.9.9" } as unknown;
    const res = validateCamIR(bad);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === "SCHEMA")).toBe(true);
  });

  it("未定义的 setup_id 引用被拒绝", () => {
    const ir = baseIR();
    ir.operations[0].setup_id = "does_not_exist";
    const res = validateCamIR(ir);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === "REF_SETUP")).toBe(true);
  });

  it("未定义的 tool_id 引用被拒绝", () => {
    const ir = baseIR();
    ir.operations[0].tool.tool_id = "t_missing";
    const res = validateCamIR(ir);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === "REF_TOOL")).toBe(true);
  });

  it("依赖自身的工序被拒绝", () => {
    const ir = baseIR();
    ir.operations[0].depends_on = ["op1"];
    const res = validateCamIR(ir);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === "REF_SELF")).toBe(true);
  });

  it("转速超过机床上限被拒绝", () => {
    const ir = baseIR();
    ir.operations[0].parameters.spindle_speed_rpm = 20000;
    const res = validateCamIR(ir);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.code === "PARAM_SPINDLE")).toBe(true);
  });

  it("重复 op_index 给出警告", () => {
    const ir = baseIR();
    ir.operations[1].op_index = 1;
    const res = validateCamIR(ir);
    expect(res.issues.some((i) => i.code === "DUP_OP_INDEX")).toBe(true);
  });

  it("确定性：同一 IR 两次 hash 一致", () => {
    const ir = baseIR();
    expect(camIrHash(ir)).toBe(camIrHash(baseIR()));
  });

  it("ChangeSet 携带审计与重校验标记", () => {
    const cs = makeChangeSet(
      "job_1",
      "ai-master-agent",
      [
        {
          kind: "UPDATE_PARAMETERS",
          target: "op1",
          before: { feed_mm_min: 1200 },
          after: { feed_mm_min: 900 },
          reason: "Reduce feed to avoid chatter on thin wall.",
        },
      ],
      { confidence: 0.82 },
    );
    expect(cs.id.startsWith("cs_")).toBe(true);
    expect(cs.requires_validation).toBe(true);
    expect(cs.confidence).toBe(0.82);
    expect(cs.changes[0].id.startsWith("chg_")).toBe(true);
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});
