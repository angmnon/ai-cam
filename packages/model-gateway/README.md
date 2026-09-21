# @ai-cam/model-gateway

可插拔 LLM Provider 网关：任务分级路由 + 回退链 + 超时竞争 + Prompt 模板。

## 当前状态：MockProvider-only

本仓库当前**仅内置 `MockProvider`**（`src/mock.ts`）——按 user 消息中的意图关键字返回确定性的预置 JSON 计划，用于本地开发、CI 与单元测试。

- 未内置任何真实厂商的 HTTP 客户端。
- 未硬编码任何 API key、secret、token 或 Bearer 凭据。
- 已对 `packages/model-gateway/src/` 全量检索 `sk-` / `api_key` / `API_KEY` / `secret` / `Bearer` 等模式，**确认无硬编码 key**（命中均为 `tokens` 计数字段，与凭据无关）。

## 接入真实厂商

要把真实 LLM 后端接进网关，需要：

1. **实现 `ModelProvider` 接口**（见 `src/provider.ts`），在 `complete(req)` 中调用厂商 SDK/HTTP API，并把响应适配为 `CompletionResult`。
2. **通过环境变量 / secret 注入凭据**，禁止把 key 写进源码：

   | 厂商 | 环境变量 |
   | --- | --- |
   | OpenAI | `OPENAI_API_KEY` |
   | Anthropic | `ANTHROPIC_API_KEY` |
   | DeepSeek | `DEEPSEEK_API_KEY` |
   | 其他（Gemini / Qwen / 自部署） | 按各自文档使用对应环境变量 |

3. **注册到网关**：`new ModelGateway(config).register(yourProvider)`，并通过 `GatewayConfig.routes` / `fallback` 把任务路由到该 provider。

> 生产部署请把上述 key 放到密钥管理系统（secret manager / CI secret），不要提交到 Git，也不要写入 `.env` 并被跟踪。

## 开发

```bash
pnpm --filter @ai-cam/model-gateway run test
pnpm --filter @ai-cam/model-gateway run build
pnpm --filter @ai-cam/model-gateway run lint
```
