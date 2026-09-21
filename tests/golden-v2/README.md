# Golden v2（300 规格样本）

- 生成器：`tests/golden-gen/generate.mjs`（种子 20260920，可复现，sha256=675906d9019fd8ca…）
- 组成：100 简单 / 100 中等 / 100 复杂，共 300 个特征规格样本
- **口径**：特征规格级（零件规格 + 特征对象 + 先验期望），与 `tests/golden` 20 个真实 STEP Golden 互补；
  真实 STEP 实体批量生成依赖 OCCT Worker，列入 Phase 6 H-2。
- 用途：全量回归（`tests/regression/run-regression.mjs`）覆盖 DFM/规划/刀路/仿真/后处理/校验的广谱组合。

## 为什么本目录没有 `.jsonl` 样本？

- **`golden-300.json` 就是 v2 语料本身**：单文件、300 条特征规格，是程序生成器的确定性产物；不另出一份静态 `.jsonl` 样本集，避免两份语料漂移。
- `.jsonl` 是 Beta 回流的运行时存档格式（`tests/beta/beta-sample.mjs` 抽样 + 后续 Human Correction 回填），由脚本在运行时生成到 `tests/beta/samples/`，本仓库不随附、也不静态伪造占位样本。
- 真实 STEP 实体（`.step`）批量生成依赖 OCCT Worker（Phase 6 H-2）；在 Worker 就绪前本目录无二进制实体样本，因此不编造 `.jsonl` 假样本。
