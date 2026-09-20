/**
 * Provider 抽象（P4-1）：任何 LLM 后端实现 ModelProvider 接口即可接入。
 * 本地/CI 使用 MockProvider（确定性），生产可接 OpenAI/Anthropic/Gemini/DeepSeek/Qwen/自部署。
 */
import { z } from "zod";

export const ChatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ModelSpec {
  id: string;
  vendor: "openai" | "anthropic" | "gemini" | "deepseek" | "qwen" | "local" | "mock";
  model: string;
  /** 任务分级标签（用于路由）：planner / param / explain / assistant */
  tasks: string[];
  /** 相对成本权重（mock=0，生产按厂商定价表折算） */
  cost_weight: number;
  /** 平均延迟估计 ms（生产由观测回填） */
  latency_ms?: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CompletionResult {
  content: string;
  model_id: string;
  usage: Usage;
  latency_ms: number;
  raw?: unknown;
}

export const CompletionRequestSchema = z.object({
  messages: z.array(z.object({ role: ChatRoleSchema, content: z.string() })),
  task: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  /** JSON 输出模式（部分 provider 原生支持） */
  response_format: z.enum(["text", "json_object"]).optional(),
});

export type CompletionRequest = z.infer<typeof CompletionRequestSchema>;

export interface ModelProvider {
  readonly spec: ModelSpec;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/** 估算 token：英文按词，中文按字（确定性，供测试与用量统计） */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const other = text.replace(/[\u4e00-\u9fff]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjk + other;
}
