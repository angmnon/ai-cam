/**
 * P2-46：Expert / ShopFloor 差异面板。
 * 机械自 PartView 提取：这两块仅在 expert 模式下渲染，且在 aside 中位置不同（特征列表在上、DFM 报告在下），
 * 故导出两个组件，由父级在原位置分别渲染，以保持 DOM 顺序与行为不变。
 */
import type { DfmReport, Feature } from "../api.js";

const SEVERITY_COLOR: Record<string, string> = { INFO: "#38bdf8", WARNING: "#f59e0b", BLOCKER: "#ef4444" };

export function ExpertFeaturesPanel({ features, recognizerVersion }: { features: Feature[]; recognizerVersion: string }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
        特征（{features.length}） <span style={{ color: "#64748b", fontWeight: 400 }}>识别器 {recognizerVersion}</span>
      </h3>
      {features.length === 0 && <div style={{ fontSize: 13, color: "#64748b" }}>未识别到特征。</div>}
      {features.map((f) => (
        <div key={f.id} style={{ border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", marginBottom: 8, fontSize: 13 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{f.id}</span>
            <span style={{ color: "#38bdf8" }}>{f.type}</span>
            <span style={{ marginLeft: "auto", color: "#64748b", fontSize: 12 }}>conf {(f.confidence * 100).toFixed(0)}%</span>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4 }}>
            尺寸：{Object.entries(f.dimensions ?? {}).map(([k, v]) => `${k}=${Number(v.toFixed(2))}`).join("  ") || "—"}
          </div>
          <div style={{ color: "#64748b", fontSize: 12, marginTop: 2 }}>可访问：{f.accessible_directions.join(" / ")}</div>
        </div>
      ))}
    </section>
  );
}

export function ExpertDfmPanel({ dfm }: { dfm: DfmReport | null }) {
  return (
    <section>
      <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
        DFM 报告 <span style={{ color: "#64748b", fontWeight: 400 }}>规则 {dfm?.rules_version}</span>
      </h3>
      {dfm && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10, fontSize: 12 }}>
          <span style={{ color: "#38bdf8" }}>INFO {dfm.summary.info}</span>
          <span style={{ color: "#f59e0b" }}>WARNING {dfm.summary.warning}</span>
          <span style={{ color: "#ef4444" }}>BLOCKER {dfm.summary.blocker}</span>
        </div>
      )}
      {(dfm?.items ?? []).map((it) => (
        <div key={it.id} style={{ borderLeft: `3px solid ${SEVERITY_COLOR[it.severity] ?? "#64748b"}`, background: "#1e293b", padding: "8px 10px", marginBottom: 8, fontSize: 12, borderRadius: "0 6px 6px 0" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <span style={{ color: SEVERITY_COLOR[it.severity], fontWeight: 600 }}>{it.severity}</span>
            <span style={{ color: "#94a3b8" }}>{it.code}</span>
          </div>
          <div style={{ color: "#e2e8f0", marginTop: 4 }}>{it.message}</div>
        </div>
      ))}
      {dfm?.items.length === 0 && <div style={{ fontSize: 13, color: "#64748b" }}>未发现问题，零件可制造。</div>}
    </section>
  );
}
