/**
 * Job 运行产物存储（P3-8：job_runs / nc_programs / validation_reports 的内存实现；SQL 0004 落库后同接口）。
 * 一次 runJob 流水线 = 一个 JobRun，含 NC 与校验报告产物。
 */
import { randomUUID } from "node:crypto";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import type { NcProgram } from "@ai-cam/post-core";
import type { ValidationReport } from "@ai-cam/nc-validator";

export interface JobRun {
  id: string;
  organization_id: string;
  part_id: string;
  status: "PASS" | "WARN" | "FAIL";
  pipeline: Array<{ stage: string; status: "PASS" | "WARN" | "FAIL"; detail: string }>;
  engine_version: string;
  validated: boolean;
  created_by: string;
  created_at: string;
}

export interface NcProgramRecord {
  id: string;
  organization_id: string;
  part_id: string;
  job_run_id: string;
  program_number: string;
  dialect: string;
  controller_id: string;
  nc_text: string;
  line_count: number;
  move_count: number;
  tool_changes: number;
  engine_version: string;
  created_at: string;
}

export interface ValidationReportRecord {
  id: string;
  organization_id: string;
  part_id: string;
  job_run_id: string;
  nc_program_id: string;
  status: "PASS" | "WARN" | "FAIL";
  layers: ValidationReport["layers"];
  report: ValidationReport;
  validator_version: string;
  created_at: string;
}

export interface SimulationRecord {
  id: string;
  organization_id: string;
  part_id: string;
  job_run_id: string;
  report: import("@ai-cam/stock-sim").SimulationReport;
  created_at: string;
}

export interface JobRunStore {
  createRun(input: { orgId: string; partId: string; userId: string; run: Omit<JobRun, "id" | "organization_id" | "part_id" | "created_by" | "created_at"> }): JobRun;
  createNc(input: { orgId: string; partId: string; jobRunId: string; nc: NcProgram }): NcProgramRecord;
  createValidation(input: { orgId: string; partId: string; jobRunId: string; ncProgramId: string; report: ValidationReport }): ValidationReportRecord;
  createSimulation(input: { orgId: string; partId: string; jobRunId: string; report: import("@ai-cam/stock-sim").SimulationReport }): SimulationRecord;
  latestRun(orgId: string, partId: string): JobRun | null;
  getRun(orgId: string, partId: string, jobRunId: string): JobRun;
  getNc(orgId: string, partId: string, jobRunId: string): NcProgramRecord;
  getValidation(orgId: string, partId: string, jobRunId: string): ValidationReportRecord;
  getSimulation(orgId: string, partId: string, jobRunId: string): SimulationRecord;
  /** 汇总（P3-8 一键产物） */
  getBundle(orgId: string, partId: string, jobRunId: string): { run: JobRun; nc: NcProgramRecord; validation: ValidationReportRecord; simulation: SimulationRecord } | null;
}

export function createJobRunStore(): JobRunStore {
  const runs = new Map<string, JobRun>();
  const ncs = new Map<string, NcProgramRecord>();
  const vals = new Map<string, ValidationReportRecord>();
  const sims = new Map<string, SimulationRecord>();

  const byPart = <T extends { organization_id: string; part_id: string; created_at: string }>(orgId: string, partId: string, items: T[]): T[] =>
    items.filter((r) => r.part_id === partId && r.organization_id === orgId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return {
    createRun({ orgId, partId, userId, run }) {
      const r: JobRun = { ...run, id: `jobrun_${randomUUID().replaceAll("-", "")}`, organization_id: orgId, part_id: partId, created_by: userId, created_at: new Date().toISOString() };
      runs.set(r.id, r);
      return r;
    },
    createNc({ orgId, partId, jobRunId, nc }) {
      const rec: NcProgramRecord = {
        id: `nc_${randomUUID().replaceAll("-", "")}`,
        organization_id: orgId,
        part_id: partId,
        job_run_id: jobRunId,
        program_number: nc.program_number,
        dialect: nc.dialect,
        controller_id: nc.controller_id,
        nc_text: nc.text,
        line_count: nc.lines.length,
        move_count: nc.metadata.move_count,
        tool_changes: nc.metadata.tool_changes,
        engine_version: nc.post_version,
        created_at: new Date().toISOString(),
      };
      ncs.set(rec.id, rec);
      return rec;
    },
    createSimulation({ orgId, partId, jobRunId, report }) {
      const rec: SimulationRecord = {
        id: `sim_${randomUUID().replaceAll("-", "")}`,
        organization_id: orgId,
        part_id: partId,
        job_run_id: jobRunId,
        report,
        created_at: new Date().toISOString(),
      };
      sims.set(rec.id, rec);
      return rec;
    },
    createValidation({ orgId, partId, jobRunId, ncProgramId, report }) {
      const rec: ValidationReportRecord = {
        id: `val_${randomUUID().replaceAll("-", "")}`,
        organization_id: orgId,
        part_id: partId,
        job_run_id: jobRunId,
        nc_program_id: ncProgramId,
        status: report.status,
        layers: report.layers,
        report,
        validator_version: report.validator_version,
        created_at: new Date().toISOString(),
      };
      vals.set(rec.id, rec);
      return rec;
    },
    latestRun(orgId, partId) {
      return byPart(orgId, partId, [...runs.values()])[0] ?? null;
    },
    getRun(orgId, partId, jobRunId) {
      const r = runs.get(jobRunId);
      if (!r || r.part_id !== partId || r.organization_id !== orgId) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "Job run not found.", stage: "jobs", retryable: false });
      return r;
    },
    getNc(orgId, partId, jobRunId) {
      const rec = byPart(orgId, partId, [...ncs.values()]).find((n) => n.job_run_id === jobRunId);
      if (!rec) throw new ApiError({ code: ErrorCodes.NC_POST_FAILED, message: "NC program not found.", stage: "nc", retryable: false });
      return rec;
    },
    getValidation(orgId, partId, jobRunId) {
      const rec = byPart(orgId, partId, [...vals.values()]).find((v) => v.job_run_id === jobRunId);
      if (!rec) throw new ApiError({ code: ErrorCodes.NC_VALIDATION_FAILED, message: "Validation report not found.", stage: "nc", retryable: false });
      return rec;
    },
    getSimulation(orgId, partId, jobRunId) {
      const rec = byPart(orgId, partId, [...sims.values()]).find((v) => v.job_run_id === jobRunId);
      if (!rec) throw new ApiError({ code: ErrorCodes.SIM_RUN_FAILED, message: "Simulation report not found.", stage: "sim", retryable: false });
      return rec;
    },
    getBundle(orgId, partId, jobRunId) {
      const run = runs.get(jobRunId);
      if (!run || run.part_id !== partId || run.organization_id !== orgId) return null;
      const nc = byPart(orgId, partId, [...ncs.values()]).find((n) => n.job_run_id === jobRunId);
      const val = byPart(orgId, partId, [...vals.values()]).find((v) => v.job_run_id === jobRunId);
      const sim = byPart(orgId, partId, [...sims.values()]).find((s2) => s2.job_run_id === jobRunId);
      if (!nc || !val || !sim) return null;
      return { run, nc, validation: val, simulation: sim };
    },
  };
}
