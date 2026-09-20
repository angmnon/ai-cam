/**
 * Gateway（P4-1）：任务分级路由 + 回退链。
 * 路由规则：按 task 标签选择 provider（可配置覆盖），同任务多 provider 按 cost_weight 升序。
 * 本地无 key 时全走 MockProvider；接入真实厂商只需注册对应 provider。
 */
import { z } from "zod";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./provider.js";

export const GatewayConfigSchema = z.object({
  /** task → provider id（覆盖默认路由） */
  routes: z.record(z.string()).optional(),
  /** 默认回退 provider id（找不到路由或全部失败时） */
  fallback: z.string().optional(),
  /** 单次调用超时 ms（0=不超时） */
  timeout_ms: z.number().int().nonnegative().optional(),
  max_retries: z.number().int().nonnegative().optional(),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export interface RouteDecision {
  provider_id: string;
  task: string;
  reason: string;
}

export class ModelGateway {
  private providers = new Map<string, ModelProvider>();
  private config: GatewayConfig;

  constructor(config: GatewayConfig = {}) {
    this.config = GatewayConfigSchema.parse(config);
  }

  private get timeoutMs(): number {
    return this.config.timeout_ms ?? 15000;
  }

  private get maxRetries(): number {
    return this.config.max_retries ?? 1;
  }

  register(p: ModelProvider): this {
    this.providers.set(p.spec.id, p);
    return this;
  }

  listProviders(): ModelProvider[] {
    return [...this.providers.values()];
  }

  /** 路由决策（可测试）：exact route → task 标签 → fallback */
  decide(task: string): RouteDecision {
    const exact = this.config.routes?.[task];
    if (exact && this.providers.has(exact)) return { provider_id: exact, task, reason: `explicit route for ${task}` };
    const byTask = [...this.providers.values()].filter((p) => p.spec.tasks.includes(task)).sort((a, b) => a.spec.cost_weight - b.spec.cost_weight);
    if (byTask.length > 0) return { provider_id: byTask[0].spec.id, task, reason: `task-tag match (${byTask[0].spec.vendor}, cost ${byTask[0].spec.cost_weight})` };
    const fb = this.config.fallback;
    if (fb && this.providers.has(fb)) return { provider_id: fb, task, reason: "fallback route" };
    throw new Error(`no provider for task "${task}" (${[...this.providers.keys()].join(", ") || "none registered"})`);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult & { route: RouteDecision }> {
    const decision = this.decide(req.task);
    const provider = this.providers.get(decision.provider_id)!;
    const timeoutMs = this.timeoutMs;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      try {
        const timer = timeoutMs > 0 ? new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`gateway timeout after ${timeoutMs}ms`)), timeoutMs)) : null;
        const result = timer ? await Promise.race([provider.complete(req), timer]) : await provider.complete(req);
        return { ...result, route: decision };
      } catch (err) {
        if (attempt > this.maxRetries) throw err;
      }
    }
  }
}
