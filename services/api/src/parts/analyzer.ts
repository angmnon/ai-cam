/**
 * 零件解析流水线适配器
 *  - fixture 模式：读取 Golden 夹具 JSON（真实 OCCT 输出，本机无 OCCT 时用于开发/测试/回归）
 *  - worker 模式：调用 geometry_worker（OCCT，Linux/Docker）解析 STEP + 输出 OBJ
 * 统一产出：NormalizedPartModel + FeatureGraph + DfmReport，并把 OBJ/JSON 写入对象存储。
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { buildFeatureGraph } from "@ai-cam/feature-engine";
import { analyzeDfm } from "@ai-cam/dfm";
import { parseWorkerOutput, type NormalizedPartModel } from "@ai-cam/geometry-schema";
import { storageKey, type StorageAdapter } from "../storage/storage.js";
import type { PartAnalysis } from "./part-store.js";

export interface AnalyzeInput {
  orgId: string;
  partId: string;
  filename: string;
  sourceKey: string;
  storage: StorageAdapter;
}

export interface PartAnalyzer {
  readonly mode: "fixture" | "worker";
  analyze(input: AnalyzeInput): Promise<PartAnalysis>;
}

/** fixture 模式：按文件名 stem 查找 tests/golden/parts/<stem>.json(.obj) */
export function createFixtureAnalyzer(fixturesDir: string): PartAnalyzer {
  return {
    mode: "fixture",
    async analyze({ orgId, partId, filename, storage }) {
      const stem = filename.replace(/\.(step|stp)$/i, "");
      const jsonPath = resolve(fixturesDir, `${stem}.json`);
      const objPath = resolve(fixturesDir, `${stem}.obj`);
      let raw: string;
      try {
        raw = await readFile(jsonPath, "utf8");
      } catch {
        throw new ApiError({
          code: ErrorCodes.CAD_PARSE_FAILED,
          message: `No fixture for part "${filename}" (expected ${jsonPath}). Upload a Golden part or run with worker analyzer.`,
          stage: "geometry",
          retryable: false,
        });
      }
      const part = parseWorkerOutput(raw);
      return finishAnalysis({ orgId, partId, filename, part, storage, objPath });
    },
  };
}

/** worker 模式：本地 spawn geometry_worker（OCCT）解析 STEP */
export function createWorkerAnalyzer(binaryPath: string, timeoutMs = 60_000): PartAnalyzer {
  return {
    mode: "worker",
    async analyze({ orgId, partId, filename, sourceKey, storage }) {
      const { data } = await storage.get(sourceKey);
      const dir = await mkdtemp(join(tmpdir(), "geom-"));
      const stepPath = join(dir, filename);
      const objPath = join(dir, "part.obj");
      try {
        await writeFile(stepPath, data);
        const raw = await runWorker(binaryPath, [stepPath, "--obj", objPath], timeoutMs);
        const part = parseWorkerOutput(raw);
        return await finishAnalysis({ orgId, partId, filename, part, storage, objPath });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function runWorker(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ApiError({ code: ErrorCodes.CAD_PARSE_FAILED, message: `geometry_worker timeout after ${timeoutMs}ms`, stage: "geometry", retryable: true }));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new ApiError({ code: ErrorCodes.CAD_PARSE_FAILED, message: `geometry_worker exited ${code}: ${err.slice(0, 500)}`, stage: "geometry", retryable: true }));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ApiError({ code: ErrorCodes.CAD_PARSE_FAILED, message: `cannot spawn geometry_worker: ${e.message}`, stage: "geometry", retryable: true }));
    });
  });
}

/** 公共收尾：写网格/解析产物到存储 → 特征识别 → DFM → PartAnalysis */
async function finishAnalysis(input: {
  orgId: string;
  partId: string;
  filename: string;
  part: NormalizedPartModel;
  storage: StorageAdapter;
  objPath?: string;
}): Promise<PartAnalysis> {
  const { orgId, partId, part, storage } = input;
  const meshKey = storageKey(orgId, "VIEW_MESH", partId, "v0", "part.obj");
  if (input.objPath) {
    const obj = await readFile(input.objPath);
    await storage.put(meshKey, obj, "model/obj");
  }
  const parsedKey = storageKey(orgId, "CAD_PARSED", partId, "v0", "part.json");
  await storage.put(parsedKey, Buffer.from(JSON.stringify(part)), "application/json");

  const features = buildFeatureGraph(part, partId);
  const dfm = analyzeDfm(part, features);
  return { part, features, dfm, mesh_key: input.objPath ? meshKey : undefined };
}
