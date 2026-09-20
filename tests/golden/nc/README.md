# NC 样本语料（Post Golden）

四族控制器 NC 样本，用于 **Post 校准 diff 对照、干运行参考、§10 Post Golden 回归**。

## 样本构成（92 段，每族 23 段）

| 类别 | 命名 | 数量 | 来源 |
|---|---|---|---|
| 引擎导出 | `sample_{dialect}_{stem}.nc` | 20 段/族（80 段） | `post-core` 真实引擎输出：20 个 Golden 零件 × `planPart → postProcess(makeProfile(dialect))` |
| 手工构造 | `sample_{dialect}_001~003.nc` | 3 段/族（12 段） | 参照 `calibration.ts` 出厂值构造（覆盖典型特征组合），头部已标注构造来源 |

方言族：`fanuc`（G0/G83/安全 20mm）、`syntec`（G0/G73/安全 25mm）、`mitsubishi`（G00/G83/安全 25mm）、`iso_generic`（G00/G83/安全 25mm）。

## 覆盖能力

引擎导出样本来自 `tests/golden/parts` 20 个真实 STEP 零件的规范化 JSON，覆盖：Face / Pocket / Slot / Profile / Drill（通孔、盲孔、沉孔、多孔、深腔啄钻）/ Boss / 倒角 / 环形 / 侧孔等特征；每段含程序头模态（G21 G17 G90 G94、G40 G49 G80）、换刀+G43 刀补、主轴/冷却、钻削循环（G81/G83/G73）、回参考点（G28/G30）、M05/M09/M30 结尾。

## 重新生成

```powershell
cd C:\Users\86189\Documents\CNC-Gcode\ai-cam
pnpm -r run build   # 确保各包 dist 最新
node tests/golden/nc/generate-nc-samples.mjs
```

## 质量门禁

- `packages/post-core` golden-nc 回归：四族 × 20 件全部断言通过（97/97）；
- `packages/nc-validator` 全流程 roundtrip：四族 × 20 件 Validated NC 全部 PASS（87/87）。
