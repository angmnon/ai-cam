/**
 * P2-01：监控/告警基础（不引 OTel）。
 *
 * - 进程内 Prometheus 文本格式注册表：
 *   http_requests_total{method,route,status}
 *   http_request_duration_ms_bucket/sum/count（直方图）
 *   http_errors_total{method,route,status}（status>=500）
 *   jobs_completed_total{status}
 * - Fastify onRequest/onResponse 钩子埋点（route 用路由模板，避免高基数）。
 * - GET /metrics：METRICS_TOKEN 鉴权（config.metricsToken；Bearer 或 ?token=）。
 *
 * 零新运行依赖。
 */
import { performance } from "node:perf_hooks";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, ErrorCodes } from "@ai-cam/error-codes";
import { fpRoot } from "./fp.js";

/** 直方图桶（毫秒） */
const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

type LabelBag = Record<string, string>;

function labelKey(labels: LabelBag): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

function renderLabels(labels: LabelBag): string {
  const inner = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`)
    .join(",");
  return `{${inner}}`;
}

class MetricsRegistry {
  private readonly counters = new Map<string, { name: string; labels: LabelBag; value: number }>();
  private readonly jobCounters = new Map<string, number>();
  /** duration histogram: key=method|route → { counts: number[], sum, count } */
  private readonly histograms = new Map<string, { method: string; route: string; counts: number[]; sum: number; count: number }>();

  incCounter(name: string, labels: LabelBag): void {
    const key = `${name}|${labelKey(labels)}`;
    const row = this.counters.get(key);
    if (row) row.value += 1;
    else this.counters.set(key, { name, labels, value: 1 });
  }

  observeDuration(method: string, route: string, ms: number): void {
    const key = `${method}|${route}`;
    let h = this.histograms.get(key);
    if (!h) {
      h = { method, route, counts: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
      this.histograms.set(key, h);
    }
    for (let i = 0; i < BUCKETS.length; i++) {
      if (ms <= BUCKETS[i]) h.counts[i] += 1;
    }
    h.sum += ms;
    h.count += 1;
  }

  recordJob(status: string): void {
    this.jobCounters.set(status, (this.jobCounters.get(status) ?? 0) + 1);
  }

  /** 渲染 Prometheus 文本 exposition */
  render(): string {
    const lines: string[] = [];

    // http_requests_total
    lines.push("# HELP http_requests_total Total HTTP requests.", "# TYPE http_requests_total counter");
    for (const c of this.counters.values()) {
      if (c.name === "http_requests_total") lines.push(`http_requests_total${renderLabels(c.labels)} ${c.value}`);
    }
    // http_errors_total
    lines.push("# HELP http_errors_total Total HTTP responses with status >= 500.", "# TYPE http_errors_total counter");
    for (const c of this.counters.values()) {
      if (c.name === "http_errors_total") lines.push(`http_errors_total${renderLabels(c.labels)} ${c.value}`);
    }
    // histogram
    lines.push("# HELP http_request_duration_ms HTTP request latency in milliseconds.", "# TYPE http_request_duration_ms histogram");
    for (const h of this.histograms.values()) {
      const base = { method: h.method, route: h.route };
      let cum = 0;
      for (let i = 0; i < BUCKETS.length; i++) {
        cum += h.counts[i];
        lines.push(`http_request_duration_ms_bucket${renderLabels({ ...base, le: String(BUCKETS[i]) })} ${cum}`);
      }
      lines.push(`http_request_duration_ms_bucket${renderLabels({ ...base, le: "+Inf" })} ${h.count}`);
      lines.push(`http_request_duration_ms_sum${renderLabels(base)} ${h.sum.toFixed(3)}`);
      lines.push(`http_request_duration_ms_count${renderLabels(base)} ${h.count}`);
    }
    // jobs_completed_total
    lines.push("# HELP jobs_completed_total Total background CAM jobs completed by terminal status.", "# TYPE jobs_completed_total counter");
    for (const [status, value] of this.jobCounters) {
      lines.push(`jobs_completed_total${renderLabels({ status })} ${value}`);
    }
    return lines.join("\n") + "\n";
  }
}

declare module "fastify" {
  interface FastifyInstance {
    metrics: MetricsRegistry;
  }
}

export interface MetricsOptions {
  /** 抓取令牌；未配置时端点仍可访问（开发/测试），路由内打 WARN */
  token?: string;
}

const metricsPlugin: FastifyPluginAsync<MetricsOptions> = async (app, opts = {}) => {
  const registry = new MetricsRegistry();
  app.decorate("metrics", registry);

  const startTimes = new WeakMap<FastifyRequest, number>();

  app.addHook("onRequest", async (request) => {
    startTimes.set(request, performance.now());
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unhandled";
    const method = request.method;
    const status = String(reply.statusCode);
    registry.incCounter("http_requests_total", { method, route, status });
    if (reply.statusCode >= 500) {
      registry.incCounter("http_errors_total", { method, route, status });
    }
    const start = startTimes.get(request);
    if (start !== undefined) {
      registry.observeDuration(method, route, performance.now() - start);
      startTimes.delete(request);
    }
  });

  app.get("/metrics", async (request: FastifyRequest, reply: FastifyReply) => {
    // 鉴权：配置了 METRICS_TOKEN 时校验 Bearer（或 ?token=）；未配置则开放并告警
    if (opts.token) {
      const header = request.headers.authorization ?? "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
      const queryToken = typeof request.query === "object" && request.query !== null && "token" in request.query ? String((request.query as { token?: string }).token) : "";
      if (bearer !== opts.token && queryToken !== opts.token) {
        throw new ApiError({ code: ErrorCodes.AUTH_UNAUTHORIZED, message: "Unauthorized metrics scrape.", stage: "metrics" });
      }
    } else {
      request.log.warn("METRICS_TOKEN 未配置：/metrics 端点当前公开可访问（生产必须配置）。");
    }
    reply.header("content-type", "text/plain; version=0; charset=utf-8");
    return registry.render();
  });
};

export default fpRoot(metricsPlugin);
