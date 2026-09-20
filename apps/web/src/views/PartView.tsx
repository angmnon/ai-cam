/** 零件信息面板：BBox/体积/特征列表/DFM 摘要 + 3D 视图 */
import { useEffect, useState } from "react";
import { api, type DfmReport, type Feature, type PartSummary } from "../api.js";
import { Viewer } from "../viewer/Viewer.js";

const SEVERITY_COLOR: Record<string, string> = { INFO: "#38bdf8", WARNING: "#f59e0b", BLOCKER: "#ef4444" };

export function PartView({ partId, onBack }: { partId: string; onBack: () => void }) {
  const [part, setPart] = useState<PartSummary | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [dfm, setDfm] = useState<DfmReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const [p, f, d] = await Promise.all([api.getPart(partId), api.getFeatures(partId), api.getDfm(partId)]);
      setPart(p.data);
      setFeatures(f.data.features);
      setDfm(d.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId]);

  if (busy && !part) {
    return <div style={{ padding: 32, color: "#94a3b8" }}>加载零件分析结果…</div>;
  }
  if (error) {
    return <div style={{ padding: 32, color: "#f87171" }}>加载失败：{error}</div>;
  }
  if (!part?.analysis) return null;

  const an = part.analysis;
  const bbox = an.part.bbox_mm;
  const viewerData = {
    meshUrl: an.mesh_key ? api.meshUrl(partId) : undefined,
    features,
    partBBox: { min: { x: bbox.min[0], y: bbox.min[1], z: bbox.min[2] }, max: { x: bbox.max[0], y: bbox.max[1], z: bbox.max[2] } },
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#0f172a", color: "#e2e8f0" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 20px", borderBottom: "1px solid #1e293b" }}>
        <button onClick={onBack} style={{ padding: "6px 14px", cursor: "pointer", fontSize: 13, background: "#334155", border: "none", color: "#e2e8f0", borderRadius: 6 }}>
          ← 返回
        </button>
        <strong style={{ fontSize: 16 }}>{part.filename}</strong>
        <span style={{ fontSize: 12, color: "#64748b" }}>{part.id}</span>
        <span style={{ fontSize: 12, padding: "2px 10px", borderRadius: 999, background: part.status === "ANALYZED" ? "#14532d" : "#7c2d12", color: part.status === "ANALYZED" ? "#86efac" : "#fca5a5" }}>
          {part.status}
        </span>
        <button onClick={() => void load()} style={{ marginLeft: "auto", padding: "6px 14px", cursor: "pointer", fontSize: 13, background: "#3b82f6", border: "none", color: "#fff", borderRadius: 6 }}>
          刷新
        </button>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* 3D 视图 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Viewer data={viewerData} />
        </div>

        {/* 信息面板 */}
        <aside style={{ width: 380, minWidth: 380, overflowY: "auto", borderLeft: "1px solid #1e293b", padding: 16, boxSizing: "border-box" }}>
          <section style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>零件信息</h3>
            <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
              <tbody>
                {[
                  ["长度 (mm)", bbox.max[0] - bbox.min[0]],
                  ["宽度 (mm)", bbox.max[1] - bbox.min[1]],
                  ["高度 (mm)", bbox.max[2] - bbox.min[2]],
                  ["体积 (mm³)", an.part.volume_mm3],
                  ["实体数", an.part.solid_count],
                  ["面数", an.part.face_count],
                  ["Healing 有效", an.part.healing_valid ? "是" : "否"],
                  ["OCCT", an.part.occt_version],
                ].map(([k, v]) => (
                  <tr key={String(k)} style={{ borderBottom: "1px solid #1e293b" }}>
                    <td style={{ padding: "6px 0", color: "#94a3b8" }}>{k}</td>
                    <td style={{ padding: "6px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{typeof v === "number" ? Number(v.toFixed(2)).toLocaleString() : v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
              特征（{features.length}） <span style={{ color: "#64748b", fontWeight: 400 }}>识别器 {an.features.recognizer_version}</span>
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
        </aside>
      </div>
    </div>
  );
}
