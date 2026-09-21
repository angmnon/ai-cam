import { describe, expect, it } from "vitest";
import { JobInputSchema, JobRecordSchema, JobStatuses } from "./job.js";

describe("job-schema zod (P2-02)", () => {
  it("合法 JobInput parse 通过（全可选字段省略）", () => {
    const input = {
      part_id: "part_1",
      machine_id: "m_vmc",
      controller_id: "c_fanuc",
      material_id: "mat_6061",
    };
    const parsed = JobInputSchema.parse(input);
    expect(parsed.part_id).toBe("part_1");
    expect(parsed.axis_mode).toBeUndefined();
  });

  it("合法 JobInput parse 通过（带完整可选字段）", () => {
    const input = {
      part_id: "part_2",
      machine_id: "m_vmc",
      controller_id: "c_fanuc",
      material_id: "mat_6061",
      stock_policy: "MANUAL",
      tool_policy: { mode: "BALANCED", prefer_existing: true, max_tool_count: 6 },
      quality: { surface_priority: "HIGH", dimension_tolerance: "TIGHT" },
      axis_mode: "INDEXED_4AXIS",
      fixture_mode: "MANUAL",
    };
    const parsed = JobInputSchema.parse(input);
    expect(parsed.tool_policy?.max_tool_count).toBe(6);
    expect(parsed.axis_mode).toBe("INDEXED_4AXIS");
  });

  it("缺必填字段（part_id）parse 失败", () => {
    const bad = {
      machine_id: "m_vmc",
      controller_id: "c_fanuc",
      material_id: "mat_6061",
    };
    const res = JobInputSchema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.join(".") === "part_id")).toBe(true);
    }
  });

  it("类型错误（material_id 为数字）parse 失败", () => {
    const bad = {
      part_id: "part_1",
      machine_id: "m_vmc",
      controller_id: "c_fanuc",
      material_id: 12345,
    };
    const res = JobInputSchema.safeParse(bad);
    expect(res.success).toBe(false);
  });

  it("空字符串必填字段 parse 失败", () => {
    const bad = {
      part_id: "",
      machine_id: "m_vmc",
      controller_id: "c_fanuc",
      material_id: "mat_6061",
    };
    expect(JobInputSchema.safeParse(bad).success).toBe(false);
  });

  it("非法枚举值（stock_policy=FOO）parse 失败", () => {
    const bad = {
      part_id: "part_1",
      machine_id: "m_vmc",
      controller_id: "c_fanuc",
      material_id: "mat_6061",
      stock_policy: "FOO",
    };
    expect(JobInputSchema.safeParse(bad).success).toBe(false);
  });

  it("合法 JobRecord parse 通过", () => {
    const rec = {
      id: "job_1",
      organization_id: "org_1",
      machine_id: "m_vmc",
      controller_id: "c_fanuc",
      material_id: "mat_6061",
      status: "READY_FOR_REVIEW",
      version: 3,
      created_by: "u_1",
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T01:00:00Z",
    };
    const parsed = JobRecordSchema.parse(rec);
    expect(parsed.status).toBe("READY_FOR_REVIEW");
    expect(parsed.version).toBe(3);
  });

  it("JobRecord 非法 status parse 失败", () => {
    const rec = {
      id: "job_1",
      organization_id: "org_1",
      machine_id: "m_vmc",
      controller_id: "c_fanuc",
      material_id: "mat_6061",
      status: "NOT_A_REAL_STATUS",
      version: 0,
      created_by: "u_1",
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T01:00:00Z",
    };
    expect(JobRecordSchema.safeParse(rec).success).toBe(false);
  });

  it("所有 JobStatuses 均为合法 status 枚举值", () => {
    for (const s of JobStatuses) {
      expect(JobRecordSchema.shape.status.safeParse(s).success).toBe(true);
    }
  });
});
