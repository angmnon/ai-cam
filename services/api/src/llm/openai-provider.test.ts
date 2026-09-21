/**
 * P1-06：真实 LLM provider（OpenAI Chat Completions 兼容）+ 降级验证。
 *
 * 说明：未持有真实厂商 key，故用本地 http stub 模拟 OpenAI 兼容上游，
 * 验证 (a) 请求/响应协议正确；(b) 上游失败时 ModelGateway 自动回退 MockProvider。
 * 真实 LLM 端到端调用未实跑（无 key），仅实现 + 降级验证。
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import { loadConfig } from "../config.js";
import { createOpenAiCompatibleProvider } from "./openai-provider.js";
import { buildLlmGateway } from "./build-gateway.js";
import { MOCK_PROVIDER_SPEC } from "@ai-cam/model-gateway";

interface Stub {
  server: Server;
  port: number;
  lastBody?: unknown;
  status: number;
}

function startStub(handler: (body: unknown) => { status: number; json: unknown }): Promise<Stub> {
  return new Promise((resolve) => {
    const stub: Stub = { server: null as unknown as Server, port: 0, status: 200 };
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: unknown = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* ignore */
        }
        stub.lastBody = body;
        const { status, json } = handler(body);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      stub.server = server;
      stub.port = (server.address() as { port: number }).port;
      resolve(stub);
    });
  });
}

describe("P1-06 真实 LLM provider（本地 stub 协议验证）", () => {
  let okStub: Stub;
  let failStub: Stub;

  beforeAll(async () => {
    okStub = await startStub(() => ({
      status: 200,
      json: {
        choices: [{ message: { role: "assistant", content: '{"strategy":"finish_priority"}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      },
    }));
    failStub = await startStub(() => ({ status: 500, json: { error: "boom" } }));
  });

  afterAll(async () => {
    await new Promise<void>((r) => okStub.server.close(() => r()));
    await new Promise<void>((r) => failStub.server.close(() => r()));
  });

  it("按 OpenAI Chat Completions 兼容协议发送请求并解析响应/usage", async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: `http://127.0.0.1:${okStub.port}/v1`,
      apiKey: "sk-test-not-real",
      model: "gpt-4o-mini",
    });
    const result = await provider.complete({
      messages: [
        { role: "system", content: "be precise" },
        { role: "user", content: "表面光洁度优先" },
      ],
      task: "planner",
      response_format: "json_object",
    });
    // 请求体正确
    const sent = okStub.lastBody as Record<string, unknown>;
    expect(sent.model).toBe("gpt-4o-mini");
    expect(Array.isArray(sent.messages)).toBe(true);
    expect((sent.messages as unknown[])).toHaveLength(2);
    expect(sent.response_format).toEqual({ type: "json_object" });
    // 响应解析正确
    expect(result.content).toContain("finish_priority");
    expect(result.usage.total_tokens).toBe(16);
    expect(result.model_id).toContain("gpt-4o-mini");
  });

  it("上游 5xx 时抛错（不吞），交由 gateway 回退 mock", async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: `http://127.0.0.1:${failStub.port}/v1`,
      apiKey: "sk-test-not-real",
      model: "deepseek-chat",
      vendor: "deepseek",
    });
    await expect(
      provider.complete({ messages: [{ role: "user", content: "x" }], task: "planner" }),
    ).rejects.toThrow(/LLM upstream 500/);
  });

  it("live 装配：真实上游失败 → 自动降级 MockProvider 返回确定性结果", async () => {
    const gateway = buildLlmGateway({
      llmLive: true,
      provider: "generic",
      baseUrl: `http://127.0.0.1:${failStub.port}/v1`,
      apiKey: "sk-test-not-real",
      model: "default",
    });
    const result = await gateway.complete({
      messages: [{ role: "user", content: "表面光洁度优先" }],
      task: "planner",
      response_format: "json_object",
    });
    // 真实上游 500，回退到 mock；route 标注 fallback
    expect(result.content).toContain("finish_priority");
    expect(result.route.provider_id).toBe(MOCK_PROVIDER_SPEC.id);
  });
});

describe("P1-06 config 解析", () => {
  it("无任何 key → llmLive=false（全程 mock）", () => {
    const cfg = loadConfig({ PORT: "8080", JWT_SECRET: "x" } as NodeJS.ProcessEnv);
    expect(cfg.ai.llmLive).toBe(false);
    expect(cfg.ai.apiKey).toBeUndefined();
  });

  it("LLM_API_KEY + LLM_BASE_URL → generic live", () => {
    const cfg = loadConfig({
      PORT: "8080",
      JWT_SECRET: "x",
      LLM_API_KEY: "sk-x",
      LLM_BASE_URL: "http://gateway.local/v1/",
    } as NodeJS.ProcessEnv);
    expect(cfg.ai.llmLive).toBe(true);
    expect(cfg.ai.provider).toBe("generic");
    expect(cfg.ai.baseUrl).toBe("http://gateway.local/v1");
  });

  it("DEEPSEEK_API_KEY → deepseek provider", () => {
    const cfg = loadConfig({ PORT: "8080", JWT_SECRET: "x", DEEPSEEK_API_KEY: "sk-ds" } as NodeJS.ProcessEnv);
    expect(cfg.ai.llmLive).toBe(true);
    expect(cfg.ai.provider).toBe("deepseek");
    expect(cfg.ai.model).toBe("deepseek-chat");
  });
});
