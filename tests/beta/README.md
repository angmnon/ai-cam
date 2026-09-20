# 封闭测试与种子客户数据采集（H-6）

> 目标：在受控范围（Beta 客户）收集 **AI Proposal + Human Correction** 配对数据，
> 用于后续微调与工艺库回填。数据格式统一为 JSONL，便于离线分析。

## 数据形态

每条记录（一行 JSON）描述一次"AI 出方案 → 人工修正"闭环：

```jsonc
{
  "schema_version": "1.0.0",
  "record_id": "beta_20260920_0001",
  "captured_at": "2026-09-20T10:30:00+07:00",
  "tenant_id": "seed_customer_01",
  "part": { "file": "fixture_plate_a1.step", "bbox_mm": { "min": [0,0,0], "max": [200,120,25] }, "volume_mm3": 432000 },
  "ai_proposal": {
    "features": ["HOLE_THROUGH f1", "POCKET f2"],
    "operations": [{ "type": "DRILL", "feature_id": "f1", "tool_id": "T_DRILL_8" }],
    "setups": 1,
    "sim_status": "PASS",
    "nc_lines": 210
  },
  "human_correction": {
    "changed_ops": [{ "type": "POCKET", "feature_id": "f2", "change": "tool_id T_EMD_10 → T_EMD_12（粗铣余量 0.3→0.5）" }],
    "reason": "客户现场刀具库存无 T_EMD_10",
    "accepted_ops": ["DRILL f1"],
    "final_nc_lines": 215
  },
  "labels": { "ai_plan_accepted_ratio": 0.9, "correction_kind": ["tool_selection"] }
}
```

## 采集脚本

- `beta-sample.mjs`：把 `tests/golden-v2/golden-300.json` 抽样 20 件跑出 AI Proposal 存档到 `tests/beta/samples/`（自动标注 `human_correction: null` 待人工）。
- 人工修正由种子客户在 Beta 环境中填写后回传，格式与本 schema 一致。

## 使用边界（诚实声明）

- 当前为**采集框架与样例**，尚未有真实种子客户数据；`tests/beta/samples/` 中数据全部为系统自产（AI Proposal 真实引擎输出，Human Correction 为示例占位）。
- 封闭测试范围、客户名单与数据回传通道需在 Phase 6 收尾评审中与业务确认。

## 文件

```
tests/beta/
  README.md              本文件
  beta-corpus-schema.json  JSON Schema（校验记录）
  beta-sample.mjs          抽样采集脚本
  samples/                采集产物（JSONL）
```
