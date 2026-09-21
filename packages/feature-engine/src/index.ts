/**
 * Feature Engine v1 — 确定性启发式特征识别。
 *
 * 【v1 特征类别边界声明】（P2-07；仅文档约定，不改变识别行为/输出）
 *
 * 已支持（会产出 FeatureCandidate，进入 FeatureGraph 并参与 DFM / 规划）：
 *   - HOLE_THROUGH / HOLE_BLIND   竖直圆柱孔（通孔/盲孔）
 *   - POCKET / OPEN_POCKET / SLOT 多边形凹腔/开放腔/长槽
 *   - BOSS / STEP                 凸台 / 台阶
 *   - CHAMFER                     斜面倒角（法向 z∈[0.35,0.94] 判定）
 *   - OUTER_PROFILE               外轮廓/主基座顶面
 *   - PLANAR_FACE                 残留斜平面兜底
 *
 * 仅部分支持 / 未支持（v1 不保证识别，下游不得假定其必然出现）：
 *   - COUNTERBORE（沉头孔）：仅作为孔族被粗略归入 HOLE_*，未识别沉头台阶几何 → 部分支持
 *   - FILLET（圆角/倒圆）：v1 不识别（仅按面类型枚举，无圆角特征）
 *   - COUNTERBORE 完整族（沉头/锪平/柱窝全特征）：未支持
 *   - INNER_PROFILE（内轮廓/内壁特征）：未支持（v1 仅识别外轮廓 OUTER_PROFILE）
 *
 * 注：以上为 v1 识别能力边界；新增类别须同步此处与 golden 用例，避免静默漏检。
 */
export * from "./recognize.js";
export * from "./graph.js";
export * from "./vec.js";
