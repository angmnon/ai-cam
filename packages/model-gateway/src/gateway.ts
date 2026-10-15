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

  /** 单次调用：带超时竞争，成功/失败均清理 timer（P2-35） */
  private async callWithTimeout(provider: ModelProvider, req: CompletionRequest): Promise<CompletionResult> {
    const timeoutMs = this.timeoutMs;
    if (timeoutMs <= 0) return provider.complete(req);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`gateway timeout after ${timeoutMs}ms`)), timeoutMs);
      });
      return await Promise.race([provider.complete(req), timeoutPromise]);
    } finally {
      // P2-35：成功路径也必须 clearTimeout，避免悬挂 timer / 未处理拒绝
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult & { route: RouteDecision }> {
    const decision = this.decide(req.task);
    // P2-35：真回退链 —— 按注册顺序轮换 provider，从决策 provider 开始
    const ordered = this.listProviders();
    if (ordered.length === 0) throw new Error(`no provider for task "${req.task}"`);
    const startIdx = Math.max(0, ordered.findIndex((p) => p.spec.id === decision.provider_id));
    const chain = ordered.slice(startIdx).concat(ordered.slice(0, startIdx));

    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      try {
        const result = await this.callWithTimeout(provider, req);
        const route: RouteDecision =
          i === 0
            ? decision
            : { ...decision, provider_id: provider.spec.id, reason: `${decision.reason} → fallback provider ${provider.spec.id}` };
        return { ...result, route };
      } catch (err) {
        // P2-35：不抛错，换到注册顺序的下一 provider；全部失败后才抛
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
