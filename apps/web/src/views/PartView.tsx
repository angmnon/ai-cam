/** 零件信息面板：BBox/体积/特征列表/DFM 摘要 + CAM 刀路工作台 + 3D 视图 */
import { useEffect, useState } from "react";
import { api, type CamIr, type DfmReport, type Feature, type PartSummary } from "../api.js";
import { Viewer } from "../viewer/Viewer.js";

const SEVERITY_COLOR: Record<string, string> = { INFO: "#38bdf8", WARNING: "#f59e0b", BLOCKER: "#ef4444" };
const OP_COLOR: Record<string, string> = { FACE: "#38bdf8", POCKET: "#f59e0b", DRILL: "#34d399", CONTOUR: "#f472b6", CHAMFER: "#fbbf24" };

export function PartView({ partId, onBack }: { partId: string; onBack: () => void }) {
  const [part, setPart] = useState<PartSummary | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [dfm, setDfm] = useState<DfmReport | null>(null);
  const [cam, setCam] = useState<CamIr | null>(null);
  const [camRevision, setCamRevision] = useState<number | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [showToolpaths, setShowToolpaths] = useState(true);
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
      // 已生成的 CAM 计划（无则 404 忽略）
      try {
        const tp = await api.getToolpath(partId);
        setCam(tp.data.cam);
        setCamRevision(tp.data.revision_no);
      } catch (err) {
        if ((err as { code?: string }).code !== "CAM_REVISION_NOT_FOUND") throw err;
        setCam(null);
        setCamRevision(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const generateToolpath = async () => {
    setCamError(null);
    try {
      const res = await api.generateToolpath(partId);
      setCam(res.data.cam);
      setCamRevision(res.data.revision.revision_no);
    } catch (err) {
      setCamError(err instanceof Error ? err.message : String(err));
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
    toolpaths: showToolpaths && cam ? cam.toolpaths.map((tp) => ({ operation_id: tp.operation_id, moves: tp.moves })) : undefined,
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

          <section style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
              CAM 工艺计划 <span style={{ color: "#64748b", fontWeight: 400 }}>{camRevision ? `rev ${camRevision}` : "未生成"}</span>
            </h3>
            {part.status === "ANALYZED" && (
              <button
                onClick={() => void generateToolpath()}
                disabled={!!cam}
                style={{ padding: "7px 14px", cursor: cam ? "not-allowed" : "pointer", fontSize: 13, background: cam ? "#334155" : "#3b82f6", border: "none", color: "#fff", borderRadius: 6, marginBottom: 10 }}
              >
                {cam ? "已生成（重新 POST 可更新）" : "生成 3 轴刀路"}
              </button>
            )}
            {camError && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 8 }}>生成失败：{camError}</div>}
            {cam && (
              <>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>
                  {cam.machine.machine_name} · {cam.material.material_name}（{cam.material.grade}） · 引擎 {cam.metadata.generator_version} · 退刀 {cam.setups[0]?.wcs}
                </div>
                <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
                  <input type="checkbox" checked={showToolpaths} onChange={() => setShowToolpaths(!showToolpaths)} /> 3D 叠加刀路
                </label>
                <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid #334155", borderRadius: 8 }}>
                  <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "#64748b", textAlign: "left", position: "sticky", top: 0, background: "#0f172a" }}>
                        <th style={{ padding: "6px 8px" }}>#</th>
                        <th style={{ padding: "6px 8px" }}>类型</th>
                        <th style={{ padding: "6px 8px" }}>工序</th>
                        <th style={{ padding: "6px 8px" }}>刀具</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>S rpm</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>F mm/min</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>moves</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cam.operations.map((op) => {
                        const tp = cam.toolpaths.find((t) => t.operation_id === op.id);
                        return (
                          <tr key={op.id} style={{ borderTop: "1px solid #1e293b" }}>
                            <td style={{ padding: "5px 8px", color: "#64748b" }}>{op.op_index}</td>
                            <td style={{ padding: "5px 8px", color: OP_COLOR[op.type] ?? "#94a3b8", fontWeight: 600 }}>{op.type}</td>
                            <td style={{ padding: "5px 8px" }}>{op.name}</td>
                            <td style={{ padding: "5px 8px", color: "#94a3b8" }}>T{op.tool.tool_number}</td>
                            <td style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(Number(op.parameters.spindle_rpm ?? 0)).toLocaleString()}</td>
                            <td style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(Number(op.parameters.feed_mm_min ?? 0)).toLocaleString()}</td>
                            <td style={{ padding: "5px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{tp?.move_count ?? 0}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
                  总计 {cam.toolpaths.reduce((s, t) => s + t.move_count, 0).toLocaleString()} 个刀路点 · {cam.tools.length} 把刀具
                </div>
              </>
            )}
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
