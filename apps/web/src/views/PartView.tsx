/** 零件信息面板：BBox/体积/特征列表/DFM 摘要 + CAM 刀路工作台 + 仿真播放 + 一键 Job + 3D 视图 */
import { useEffect, useState } from "react";
import { api, BASE, type AiPlanResult, type CamIr, type DfmReport, type Feature, type JobSummary, type PartSummary, type ReleaseRecord } from "../api.js";
import { Viewer } from "../viewer/Viewer.js";
import { SimPlayer } from "./SimPlayer.js";
import { AiPanel } from "./AiPanel.js";
import { ExpertDfmPanel, ExpertFeaturesPanel } from "./ExpertShopFloor.js";
import { planFixture, clampConflict } from "@ai-cam/fixture-engine";
import { designSoftJaw, toObj, estimateVolume } from "@ai-cam/soft-jaw";

const OP_COLOR: Record<string, string> = { FACE: "#38bdf8", POCKET: "#f59e0b", DRILL: "#34d399", CONTOUR: "#f472b6", CHAMFER: "#fbbf24" };

export function PartView({ partId, onBack, mode }: { partId: string; onBack: () => void; mode: "expert" | "shopfloor" }) {
  const [part, setPart] = useState<PartSummary | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [dfm, setDfm] = useState<DfmReport | null>(null);
  const [cam, setCam] = useState<CamIr | null>(null);
  const [camRevision, setCamRevision] = useState<number | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [showToolpaths, setShowToolpaths] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<JobSummary | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [showNc, setShowNc] = useState(false);
  const [ncText, setNcText] = useState<string | null>(null);
  const [aiGoal, setAiGoal] = useState("粗加工优先，兼顾表面质量");
  const [aiPlan, setAiPlan] = useState<AiPlanResult | null>(null);
  const [aiPlans, setAiPlans] = useState<Array<{ id: string; goal: string; model_route: string; prompt_version: string; created_at: string; tool_calls: Array<{ tool: string; ok: boolean }> }>>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [releases, setReleases] = useState<ReleaseRecord[]>([]);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releaseNote, setReleaseNote] = useState("");
  const [showJawObj, setShowJawObj] = useState(false);

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

  const runJob = async () => {
    setJobBusy(true);
    setJobError(null);
    setNcText(null);
    try {
      const res = await api.runJob(partId);
      setJob(res.data);
    } catch (err) {
      setJobError(err instanceof Error ? err.message : String(err));
    } finally {
      setJobBusy(false);
    }
  };

  const loadNc = async () => {
    if (ncText) return;
    try {
      const res = await fetch(`${BASE}/api/v1/parts/${partId}/job/nc`, { headers: { authorization: `Bearer ${localStorage.getItem("ai_cam_token") ?? ""}` } });
      if (res.ok) setNcText(await res.text());
    } catch {
      /* noop */
    }
  };

  const runAiPlan = async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await api.runAiPlan(partId, aiGoal);
      setAiPlan(res.data);
      const list = await api.listAiPlans(partId);
      setAiPlans(list.data);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
    }
  };

  const applyAiPlan = async () => {
    if (!aiPlan) return;
    setAiError(null);
    try {
      await api.applyAiPlan(partId, aiPlan.plan.id);
      setAiPlan(null);
      const tp = await api.getToolpath(partId);
      setCam(tp.data.cam);
      await runAiPlan();
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadReleases = async () => {
    try {
      setReleases((await api.listReleases(partId)).data);
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : "发布记录加载失败");
    }
  };

  const createRelease = async () => {
    setReleaseBusy(true);
    setReleaseError(null);
    try {
      const rel = (await api.createRelease(partId)).data;
      setReleases([rel, ...releases]);
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setReleaseBusy(false);
    }
  };

  const approveRelease = async (rid: string) => {
    try {
      const rel = (await api.approveRelease(partId, rid, releaseNote || "仿真与校验通过")).data;
      setReleases(releases.map((r) => (r.id === rid ? rel : r)));
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : String(err));
    }
  };

  const releaseNow = async (rid: string) => {
    try {
      const rel = (await api.releaseNow(partId, rid)).data;
      setReleases(releases.map((r) => (r.id === rid ? rel : r)));
    } catch (err) {
      setReleaseError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    void loadReleases();
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
  // 夹具方案（P5-2/P5-3 贯通）：3-2-1 定位 + 软爪参数
  const partBBoxObj = { min: { x: bbox.min[0], y: bbox.min[1], z: bbox.min[2] }, max: { x: bbox.max[0], y: bbox.max[1], z: bbox.max[2] } };
  const fixturePlan = planFixture(partBBoxObj, { soft_jaw: true });
  const jaw = designSoftJaw({ partBBox: partBBoxObj, clampDir: "X", fixtureId: fixturePlan.recommended_id });
  const recommendedFixture = fixturePlan.candidates.find((c) => c.id === fixturePlan.recommended_id);
  const fixtureError = recommendedFixture ? null : `未找到推荐夹具方案（${fixturePlan.recommended_id}），请检查夹具引擎输出`;
  const conflicts = recommendedFixture ? clampConflict(features, recommendedFixture) : [];

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

          {mode === "expert" && <ExpertFeaturesPanel features={features} recognizerVersion={an.features.recognizer_version} />}

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
                  {cam.machine.machine_name} · {cam.material.material_name}（{cam.material.grade}） · 引擎 {cam.metadata.generator_version} · {cam.setups.length} 个装夹
                </div>
                {cam.setups.length > 1 && (
                  <div style={{ fontSize: 12, color: "#38bdf8", marginBottom: 8 }}>
                    Setup 视图（4 轴 Index）：{cam.setups.map((s) => `${s.id} ${s.wcs}${s.rotation ? ` A${s.rotation.angle}°` : " (0°)"}${s.part_faces?.length ? ` · ${s.part_faces.length} 特征` : ""}`).join("  |  ")}
                  </div>
                )}
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

          <section style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
              Job 一键 Validated NC <span style={{ color: "#64748b", fontWeight: 400 }}>P3-8</span>
            </h3>
            {part.status === "ANALYZED" && (
              <button
                onClick={() => void runJob()}
                disabled={jobBusy}
                style={{ padding: "7px 14px", cursor: jobBusy ? "wait" : "pointer", fontSize: 13, background: "#16a34a", border: "none", color: "#fff", borderRadius: 6, marginBottom: 10 }}
              >
                {jobBusy ? "生成中（plan→sim→post→validate）…" : job ? "重新生成 Validated NC" : "一键生成 Validated NC"}
              </button>
            )}
            {jobError && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 8 }}>生成失败：{jobError}</div>}
            {job && (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, fontSize: 12 }}>
                  <span style={{ color: job.job.validated ? "#86efac" : "#fca5a5", fontWeight: 600 }}>{job.job.validated ? "✔ VALIDATED" : "✘ NOT VALIDATED"}</span>
                  <span style={{ color: "#94a3b8" }}>{job.nc.program_number} · {job.nc.dialect} · {job.nc.line_count} 行 · {job.nc.tool_changes} 次换刀</span>
                </div>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginBottom: 8 }}>
                  <tbody>
                    {job.job.pipeline.map((p) => (
                      <tr key={p.stage} style={{ borderBottom: "1px solid #1e293b" }}>
                        <td style={{ padding: "5px 8px", color: "#94a3b8", fontWeight: 600 }}>{p.stage}</td>
                        <td style={{ padding: "5px 8px", color: p.status === "PASS" ? "#86efac" : p.status === "WARN" ? "#fbbf24" : "#f87171" }}>{p.status}</td>
                        <td style={{ padding: "5px 8px", color: "#64748b" }}>{p.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
                  仿真：{job.simulation.status} · 切除 {job.simulation.removed_volume_mm3.toLocaleString()} mm³ · 残料 {job.simulation.residual_volume_mm3.toLocaleString()} mm³ · 事件 {job.simulation.events}
                </div>
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  {job.validation.layers.map((l) => (
                    <span key={l.layer} style={{ marginRight: 10, color: l.status === "PASS" ? "#86efac" : l.status === "WARN" ? "#fbbf24" : "#f87171" }}>
                      {l.layer}={l.status}({l.checks})
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => {
                    setShowNc(!showNc);
                    if (!ncText) void loadNc();
                  }}
                  style={{ padding: "5px 12px", cursor: "pointer", fontSize: 12, background: "#334155", border: "none", color: "#e2e8f0", borderRadius: 6, marginBottom: 8 }}
                >
                  {showNc ? "隐藏 NC 程序" : "查看 NC 程序"}
                </button>
                {showNc && (
                  <pre style={{ maxHeight: 180, overflow: "auto", fontSize: 11, lineHeight: 1.5, background: "#0b1220", color: "#cbd5e1", padding: 10, borderRadius: 8, border: "1px solid #1e293b", whiteSpace: "pre", margin: 0 }}>
                    {ncText ?? "加载中…"}
                  </pre>
                )}
              </>
            )}
          </section>

          {mode === "expert" && (
            <AiPanel
              aiGoal={aiGoal}
              setAiGoal={setAiGoal}
              onRun={() => void runAiPlan()}
              aiBusy={aiBusy}
              aiError={aiError}
              aiPlan={aiPlan}
              onApply={() => void applyAiPlan()}
              aiPlans={aiPlans}
            />
          )}

          <section style={{ marginBottom: 20, borderTop: "1px solid #1e293b", paddingTop: 16 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
              Release 发布 <span style={{ color: "#64748b", fontWeight: 400 }}>P4-11 · 审批链</span>
            </h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button
                onClick={() => void createRelease()}
                disabled={releaseBusy || !job}
                style={{ padding: "7px 14px", cursor: releaseBusy ? "wait" : job ? "pointer" : "not-allowed", fontSize: 13, background: job ? "#3b82f6" : "#334155", border: "none", color: "#fff", borderRadius: 6 }}
              >
                {releaseBusy ? "创建中…" : "发起 Release 申请"}
              </button>
              <input
                value={releaseNote}
                onChange={(e) => setReleaseNote(e.target.value)}
                style={{ flex: 1, padding: "6px 10px", fontSize: 12, background: "#0b1220", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 6 }}
                placeholder="审批备注（可选）"
              />
            </div>
            {releaseError && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 8 }}>{releaseError}</div>}
            {releases.length === 0 && <div style={{ fontSize: 12, color: "#64748b" }}>暂无发布记录。先生成 Job，再发起 Release 申请。</div>}
            {releases.map((r) => (
              <div key={r.id} style={{ border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", marginBottom: 8, fontSize: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>v{r.version_no}</span>
                  <span style={{ color: "#64748b" }}>{r.id.slice(0, 12)}…</span>
                  <span style={{ marginLeft: "auto", color: r.status === "RELEASED" ? "#86efac" : r.status === "APPROVED" ? "#38bdf8" : r.status === "REJECTED" ? "#f87171" : "#fbbf24", fontWeight: 600 }}>{r.status}</span>
                </div>
                <div style={{ color: "#94a3b8", marginTop: 4 }}>
                  cam {r.cam_revision_id.slice(0, 10)}… · job {r.job_run_id.slice(0, 10)}… · 申请人 {r.requested_by.slice(0, 8)} · QR {r.qr_token}
                </div>
                {r.approval_note && <div style={{ color: "#64748b", marginTop: 2 }}>备注：{r.approval_note}</div>}
                {r.status === "PENDING_APPROVAL" && (
                  <button onClick={() => void approveRelease(r.id)} style={{ marginTop: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, background: "#16a34a", border: "none", color: "#fff", borderRadius: 6 }}>
                    审批通过
                  </button>
                )}
                {r.status === "APPROVED" && (
                  <button onClick={() => void releaseNow(r.id)} style={{ marginTop: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, background: "#3b82f6", border: "none", color: "#fff", borderRadius: 6 }}>
                    正式发布
                  </button>
                )}
              </div>
            ))}
          </section>

          <section style={{ marginBottom: 20, borderTop: "1px solid #1e293b", paddingTop: 16 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
              夹具方案 <span style={{ color: "#64748b", fontWeight: 400 }}>P5-2/3 · 3-2-1 定位 + 软爪</span>
            </h3>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>
              定位 {fixturePlan.locate.constraint_count} 点（{fixturePlan.locate.locators.filter((l) => l.kind === "PRIMARY").length} 主基准 · {fixturePlan.locate.locators.filter((l) => l.kind === "SECONDARY").length} 导向 · {fixturePlan.locate.locators.filter((l) => l.kind === "TERTIARY").length} 止动）· 推荐 {fixturePlan.recommended_id}
            </div>
            {fixtureError && (
              <div style={{ fontSize: 12, color: "#f87171", marginBottom: 6, padding: "6px 8px", border: "1px solid #7f1d1d", borderRadius: 6, background: "#450a0a" }}>
                错误：{fixtureError}
              </div>
            )}
            <div style={{ fontSize: 12, color: "#e2e8f0", marginBottom: 6 }}>
              软爪 {jaw.id}：槽宽 {jaw.params.slot_width_mm}mm · 槽深 {jaw.params.slot_depth_mm}mm · 爪体 {jaw.params.length_mm}×{jaw.params.width_mm}×{jaw.params.height_mm}mm · 体积≈{Math.round(estimateVolume(jaw)).toLocaleString()} mm³ · 材料 {jaw.params.material}
            </div>
            {conflicts.length > 0 && (
              <div style={{ fontSize: 12, color: "#f59e0b", marginBottom: 6 }}>
                夹持冲突提示：{conflicts.join("；")}
              </div>
            )}
            <button
              onClick={() => setShowJawObj(!showJawObj)}
              style={{ padding: "4px 12px", cursor: "pointer", fontSize: 12, background: "#334155", border: "none", color: "#e2e8f0", borderRadius: 6 }}
            >
              {showJawObj ? "隐藏软爪 OBJ" : "查看软爪 OBJ"}
            </button>
            {showJawObj && (
              <pre style={{ maxHeight: 160, overflow: "auto", fontSize: 10, lineHeight: 1.4, background: "#0b1220", color: "#cbd5e1", padding: 10, borderRadius: 8, border: "1px solid #1e293b", whiteSpace: "pre", margin: "8px 0 0" }}>
                {toObj(jaw)}
              </pre>
            )}
          </section>

          {job?.simulation.frames && job.simulation.frames.length > 0 && (
            <section style={{ marginBottom: 20 }}>
              <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
                仿真播放 <span style={{ color: "#64748b", fontWeight: 400 }}>俯视剩余毛坯</span>
              </h3>
              <SimPlayer frames={job.simulation.frames} partBBox={{ min: { x: bbox.min[0], y: bbox.min[1], z: bbox.min[2] }, max: { x: bbox.max[0], y: bbox.max[1], z: bbox.max[2] } }} />
            </section>
          )}

          {mode === "expert" && <ExpertDfmPanel dfm={dfm} />}
        </aside>
      </div>
    </div>
  );
}
