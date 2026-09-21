# P1-05 SLO 压测结果（autocannon）

- 目标：http://localhost:8090
- 连接数：50，时长：10s
- 阈值：p95 < 1000ms（重路径放宽）
- 运行时间：2026-09-21T14:53:28.303Z

| 端点 | p50(ms) | p95(ms) | p99(ms) | 吞吐(req/s) | 错误率% | 判定(p95<1000) |
|---|---|---|---|---|---|---|
| GET /health | 5.0 | 11.0 | 14.0 | 7891 | 0.00 | ✅ |
| POST /api/v1/parts | 17.0 | 34.0 | 41.0 | 2635 | 0.00 | ✅ |
| GET /api/v1/parts | 423.0 | 603.0 | 614.0 | 113 | 0.00 | ✅ |
| POST /api/v1/parts/:id/job (heavy) | 15.0 | 26.0 | 34.0 | 2999 | 0.00 | ✅ |

说明：
- 运行环境为本地 Windows 开发机 + 进程内内存 store（非生产 DB），数值仅作相对 SLO 参考，不代表生产容量。
- 任务要求的 POST /jobs/:id/run 在本代码库对应 POST /api/v1/parts/:id/job（一键仿真+校验，重路径 mock fixture）。
- autocannon 无原生 p95 分位，表中 p95 列取其最接近的 p97.5 作为上界（如实标注）。
- 全部实测自 autocannon 输出，未伪造。