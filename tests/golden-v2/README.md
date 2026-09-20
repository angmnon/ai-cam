# Golden v2（300 规格样本）

- 生成器：`tests/golden-gen/generate.mjs`（种子 20260920，可复现，sha256=675906d9019fd8ca…）
- 组成：100 简单 / 100 中等 / 100 复杂，共 300 个特征规格样本
- **口径**：特征规格级（零件规格 + 特征对象 + 先验期望），与 `tests/golden` 20 个真实 STEP Golden 互补；
  真实 STEP 实体批量生成依赖 OCCT Worker，列入 Phase 6 H-2。
- 用途：全量回归（`tests/regression/run-regression.mjs`）覆盖 DFM/规划/刀路/仿真/后处理/校验的广谱组合。
