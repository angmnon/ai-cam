/**
 * P0-01：Job 运行产物 PostgreSQL 实现（表：job_runs / nc_programs / validation_reports，迁移 0004；仿真报告落 job_runs.simulation_json）。
 * - 所有查询强制带 organization_id 过滤。
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { SimulationReport } from "@ai-cam/stock-sim";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import type { JobRunStore, JobRun, NcProgramRecord, ValidationReportRecord, SimulationRecord } from "../../cam/job-run-store.js";

interface RunRow {
  id: string;
  organization_id: string;
  part_id: string;
  status: string;
  pipeline: unknown;
  engine_version: string;
  created_by: string | null;
  created_at: Date;
  simulation_json: SimulationReport | null;
}

function rowToRun(row: RunRow): JobRun {
  return {
    id: row.id,
    organization_id: row.organization_id,
    part_id: row.part_id,
    status: row.status as JobRun["status"],
    pipeline: row.pipeline as JobRun["pipeline"],
    engine_version: row.engine_version,
    validated: (row.pipeline as Array<{ status?: string }> | undefined)?.every?.((p) => p.status === "PASS") ?? false,
    created_by: row.created_by ?? "",
    created_at: (row.created_at as Date)?.toISOString?.() ?? String(row.created_at),
  };
}

export function createPgJobRunStore(pool: Pool): JobRunStore {
  return {
    async createRun({ orgId, partId, userId, run }): Promise<JobRun> {
      const id = `jobrun_${randomUUID().replaceAll("-", "")}`;
      const { rows } = await pool.query<RunRow>(
        `INSERT INTO job_runs (id, organization_id, part_id, status, pipeline, engine_version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [id, orgId, partId, run.status, JSON.stringify(run.pipeline), run.engine_version, userId],
      );
      return rowToRun(rows[0]);
    },

    async createNc({ orgId, partId, jobRunId, nc }): Promise<NcProgramRecord> {
      const id = `nc_${randomUUID().replaceAll("-", "")}`;
      const { rows } = await pool.query(
        `INSERT INTO nc_programs (id, organization_id, part_id, job_run_id, program_number, dialect, controller_id, nc_text, line_count, move_count, tool_changes, engine_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [id, orgId, partId, jobRunId, nc.program_number, nc.dialect, nc.controller_id, nc.text, nc.lines.length, nc.metadata.move_count, nc.metadata.tool_changes, nc.post_version],
      );
      return rows[0] as unknown as NcProgramRecord;
    },

    async createValidation({ orgId, partId, jobRunId, ncProgramId, report }): Promise<ValidationReportRecord> {
      const id = `val_${randomUUID().replaceAll("-", "")}`;
      const { rows } = await pool.query(
        `INSERT INTO validation_reports (id, organization_id, part_id, job_run_id, nc_program_id, status, layers, report, validator_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [id, orgId, partId, jobRunId, ncProgramId, report.status, JSON.stringify(report.layers), JSON.stringify(report), report.validator_version],
      );
      return rows[0] as unknown as ValidationReportRecord;
    },

    async createSimulation({ orgId, partId, jobRunId, report }): Promise<SimulationRecord> {
      await pool.query(`UPDATE job_runs SET simulation_json = $1 WHERE id = $2 AND organization_id = $3 AND part_id = $4`, [
        JSON.stringify(report),
        jobRunId,
        orgId,
        partId,
      ]);
      return {
        id: `sim_${randomUUID().replaceAll("-", "")}`,
        organization_id: orgId,
        part_id: partId,
        job_run_id: jobRunId,
        report,
        created_at: new Date().toISOString(),
      };
    },

    async latestRun(orgId: string, partId: string): Promise<JobRun | null> {
      const { rows } = await pool.query<RunRow>(
        `SELECT * FROM job_runs WHERE part_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [partId, orgId],
      );
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async getRun(orgId: string, partId: string, jobRunId: string): Promise<JobRun> {
      const { rows } = await pool.query<RunRow>(`SELECT * FROM job_runs WHERE id = $1 AND part_id = $2 AND organization_id = $3`, [jobRunId, partId, orgId]);
      if (!rows[0]) throw new ApiError({ code: ErrorCodes.JOB_NOT_FOUND, message: "Job run not found.", stage: "jobs", retryable: false });
      return rowToRun(rows[0]);
    },

    async getNc(orgId: string, partId: string, jobRunId: string): Promise<NcProgramRecord> {
      const { rows } = await pool.query<NcProgramRecord>(
        `SELECT * FROM nc_programs WHERE job_run_id = $1 AND part_id = $2 AND organization_id = $3 ORDER BY created_at DESC LIMIT 1`,
        [jobRunId, partId, orgId],
      );
      if (!rows[0]) throw new ApiError({ code: ErrorCodes.NC_POST_FAILED, message: "NC program not found.", stage: "nc", retryable: false });
      return rows[0];
    },

    async getValidation(orgId: string, partId: string, jobRunId: string): Promise<ValidationReportRecord> {
      const { rows } = await pool.query<ValidationReportRecord>(
        `SELECT * FROM validation_reports WHERE job_run_id = $1 AND part_id = $2 AND organization_id = $3 ORDER BY created_at DESC LIMIT 1`,
        [jobRunId, partId, orgId],
      );
      if (!rows[0]) throw new ApiError({ code: ErrorCodes.NC_VALIDATION_FAILED, message: "Validation report not found.", stage: "nc", retryable: false });
      return rows[0];
    },

    async getSimulation(orgId: string, partId: string, jobRunId: string): Promise<SimulationRecord> {
      const { rows } = await pool.query<RunRow>(`SELECT * FROM job_runs WHERE id = $1 AND part_id = $2 AND organization_id = $3`, [jobRunId, partId, orgId]);
      if (!rows[0] || !rows[0].simulation_json) throw new ApiError({ code: ErrorCodes.SIM_RUN_FAILED, message: "Simulation report not found.", stage: "sim", retryable: false });
      return { id: `sim_${jobRunId}`, organization_id: orgId, part_id: partId, job_run_id: jobRunId, report: rows[0].simulation_json, created_at: new Date().toISOString() };
    },

    async getBundle(orgId: string, partId: string, jobRunId: string) {
      const run = await this.getRun(orgId, partId, jobRunId).catch(() => null);
      if (!run) return null;
      const nc = await this.getNc(orgId, partId, jobRunId).catch(() => null);
      const validation = await this.getValidation(orgId, partId, jobRunId).catch(() => null);
      const simulation = await this.getSimulation(orgId, partId, jobRunId).catch(() => null);
      if (!nc || !validation || !simulation) return null;
      return { run, nc, validation, simulation };
    },
  };
}
