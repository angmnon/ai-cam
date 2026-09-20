/** 环境配置（所有配置集中在入口读取，便于测试注入） */
import { resolve } from "node:path";
export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  nodeEnv: string;
  jwt: { secret: string; issuer: string; expiresIn: string };
  storage: { driver: "local" | "r2"; dataDir: string };
  /** 零件解析器：fixture（Golden 夹具，默认）| worker（OCCT 本地二进制） */
  partsAnalyzer: { mode: "fixture" | "worker"; fixturesDir: string; binaryPath?: string };
  otlpEndpoint?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const driver = (env.STORAGE_DRIVER ?? "local") as AppConfig["storage"]["driver"];
  if (driver !== "local" && driver !== "r2") {
    throw new Error(`Unknown STORAGE_DRIVER: ${driver}`);
  }
  const partsMode = (env.PARTS_ANALYZER ?? "fixture") as AppConfig["partsAnalyzer"]["mode"];
  if (partsMode !== "fixture" && partsMode !== "worker") {
    throw new Error(`Unknown PARTS_ANALYZER: ${partsMode}`);
  }
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    nodeEnv: env.NODE_ENV ?? "development",
    jwt: {
      secret: env.JWT_SECRET ?? "dev-secret-change-me",
      issuer: env.JWT_ISSUER ?? "ai-cam-api",
      expiresIn: env.JWT_EXPIRES_IN ?? "24h",
    },
    storage: {
      driver,
      dataDir: env.DATA_DIR ?? "./data",
    },
    partsAnalyzer: {
      mode: partsMode,
      fixturesDir: env.FIXTURES_DIR ?? resolve(process.cwd(), "../../tests/golden/parts"),
      binaryPath: env.GEOMETRY_WORKER_BIN,
    },
    otlpEndpoint: env.OTLP_ENDPOINT,
  };
}
