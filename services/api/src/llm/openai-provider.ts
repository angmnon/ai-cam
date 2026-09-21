/**
 * P1-06：真实 LLM Provider（OpenAI Chat Completions 兼容协议）。
 *
 * 适用范围：OpenAI / DeepSeek / 任何 OpenAI 兼容网关（LLM_API_KEY + LLM_BASE_URL）。
 * 仅依赖 Node 20 全局 fetch，不新增运行时依赖；失败时抛错，交由 ModelGateway 回退到 MockProvider。
 *
 * 安全约束：apiKey 只从 config 注入，禁止落盘 / 进日志 / 进审计；guardrails（Prompt 注入扫描）
 * 仍在路由层调用本 provider 之前执行，本文件不绕过任何既有校验。
 */
import {
  estimateTokens,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  type ModelSpec,
} from "@ai-cam/model-gateway";

export interface OpenAiProviderOptions {
  /** OpenAI 兼容服务的 base URL（以 /v1 结尾，不带尾部斜杠）。 */
  baseUrl: string;
  /** Bearer api key（不落日志）。 */
  apiKey: string;
  /** 模型名，如 gpt-4o-mini / deepseek-chat。 */
  model: string;
  /** vendor 分类（OpenAI 兼容协议下 generic 也归 openai）。 */
  vendor?: ModelSpec["vendor"];
  /** 单次请求超时 ms。 */
  timeoutMs?: number;
}

interface ChatCompletionChoice {
  message?: { role?: string; content?: string };
}
interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

/** 构造一个 OpenAI Chat Completions 兼容 provider。 */
export function createOpenAiCompatibleProvider(opts: OpenAiProviderOptions): ModelProvider {
  const { baseUrl, apiKey, model, vendor = "openai", timeoutMs = 60_000 } = opts;
  const spec: ModelSpec = {
    id: `llm_${vendor}_${model}`,
    vendor,
    model,
    tasks: ["planner", "param", "explain", "assistant"],
    cost_weight: 100,
    latency_ms: 800,
  };

  return {
    spec,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const body: Record<string, unknown> = {
          model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        };
        if (req.temperature !== undefined) body.temperature = req.temperature;
        if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
        // OpenAI 兼容协议：JSON 模式用 response_format: { type: "json_object" }
        if (req.response_format === "json_object") body.response_format = { type: "json_object" };

        const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          // 不回显 apiKey，仅报状态与前 300 字节错误体
          throw new Error(`LLM upstream ${res.status}: ${detail}`);
        }

        const data = (await res.json()) as ChatCompletionResponse;
        const content = data.choices?.[0]?.message?.content ?? "";
        const latency_ms = Date.now() - started;
        const promptTokens = data.usage?.prompt_tokens ?? estimateTokens(req.messages.map((m) => m.content).join("\n"));
        const completionTokens = data.usage?.completion_tokens ?? estimateTokens(content);
        return {
          content,
          model_id: spec.id,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: data.usage?.total_tokens ?? promptTokens + completionTokens,
          },
          latency_ms,
          raw: data,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
