/**
 * P1-06：LLM 运行时装配。
 *
 * - 配置了真实 key（OPENAI / DEEPSEEK / LLM_API_KEY）：注册真实 OpenAI 兼容 provider 承担全部任务，
 *   MockProvider 以空任务集作为优雅回退（真实上游失败/超时 → 自动降级 mock，保证 AI 规划链路不中断）。
 * - 未配置任何 key：仅注册 MockProvider，全链路确定性降级（CI / 本地默认）。
 *
 * x-ai-mode 由 config.ai.llmLive 决定（路由层），与本装配保持一致。
 */
import { ModelGateway, createMockProvider, MOCK_PROVIDER_SPEC, type ModelProvider } from "@ai-cam/model-gateway";
import { createOpenAiCompatibleProvider, type OpenAiProviderOptions } from "./openai-provider.js";

export type LlmVendor = "openai" | "deepseek" | "generic";

export interface LlmRuntimeConfig {
  /** 是否持有任一真实 provider key。 */
  llmLive: boolean;
  provider: LlmVendor;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

const MOCK_TASKS = MOCK_PROVIDER_SPEC.tasks;

/**
 * 构造 ModelGateway。真实 provider 承担任务路由；mock 永远注册以保证失败可降级。
 */
export function buildLlmGateway(cfg: LlmRuntimeConfig): ModelGateway {
  const gateway = new ModelGateway({ fallback: MOCK_PROVIDER_SPEC.id });

  const providers: ModelProvider[] = [];
  if (cfg.llmLive && cfg.apiKey) {
    const realOpts: OpenAiProviderOptions = {
      vendor: cfg.provider === "generic" ? "openai" : cfg.provider,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    };
    providers.push(createOpenAiCompatibleProvider(realOpts));
    // live 时 mock 不参与任务路由（空任务），仅作 fallback 链尾；未配置 key 时 mock 承担全部任务。
    providers.push(createMockProvider({ ...MOCK_PROVIDER_SPEC, tasks: [] }));
  } else {
    providers.push(createMockProvider({ ...MOCK_PROVIDER_SPEC, tasks: MOCK_TASKS }));
  }

  for (const p of providers) gateway.register(p);
  return gateway;
}
