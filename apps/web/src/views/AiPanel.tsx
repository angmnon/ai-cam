/**
 * P2-46：AI 工艺规划面板（Preview → Compare → Apply）。
 * 机械自 PartView 提取：状态与异步处理流仍保留在父级，本组件仅负责渲染并通过 props 回调触发。
 */
import type { AiPlanResult } from "../api.js";

export interface AiPlanHistoryItem {
  id: string;
  goal: string;
  model_route: string;
  prompt_version: string;
  created_at: string;
  tool_calls: Array<{ tool: string; ok: boolean }>;
}

export function AiPanel({
  aiGoal,
  setAiGoal,
  onRun,
  aiBusy,
  aiError,
  aiPlan,
  onApply,
  aiPlans,
}: {
  aiGoal: string;
  setAiGoal: (v: string) => void;
  onRun: () => void;
  aiBusy: boolean;
  aiError: string | null;
  aiPlan: AiPlanResult | null;
  onApply: () => void;
  aiPlans: AiPlanHistoryItem[];
}) {
  return (
    <section style={{ marginBottom: 20, borderTop: "1px solid #1e293b", paddingTop: 16 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>
        AI 工艺规划 <span style={{ color: "#64748b", fontWeight: 400 }}>P4-9 · Preview → Compare → Apply</span>
      </h3>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          value={aiGoal}
          onChange={(e) => setAiGoal(e.target.value)}
          style={{ flex: 1, padding: "7px 10px", fontSize: 13, background: "#0b1220", border: "1px solid #334155", color: "#e2e8f0", borderRadius: 6 }}
          placeholder="输入加工目标，如：表面光洁度优先 / 成本优先 / 效率优先"
        />
        <button
          onClick={onRun}
          disabled={aiBusy}
          style={{ padding: "7px 14px", cursor: aiBusy ? "wait" : "pointer", fontSize: 13, background: "#7c3aed", border: "none", color: "#fff", borderRadius: 6 }}
        >
          {aiBusy ? "规划中…" : "AI 规划"}
        </button>
      </div>
      {aiError && <div style={{ fontSize: 12, color: "#f87171", marginBottom: 8 }}>{aiError}</div>}
      {aiPlan && (
        <div style={{ border: "1px solid #334155", borderRadius: 8, padding: 10, fontSize: 12, marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>意图：{aiPlan.intent?.strategy ?? "（默认）"}</span>
            <span style={{ color: aiPlan.guardrail.ok ? "#86efac" : "#fca5a5", fontWeight: 600 }}>
              {aiPlan.guardrail.ok ? "✔ Guardrails 通过" : `✘ Guardrails（${aiPlan.guardrail.violations.length} 项）`}
            </span>
            <span style={{ color: aiPlan.job.validated ? "#86efac" : "#fca5a5" }}>{aiPlan.job.validated ? "✔ VALIDATED" : "✘ NOT VALIDATED"}</span>
          </div>
          {!aiPlan.guardrail.ok &&
            aiPlan.guardrail.violations.map((v, i) => (
              <div key={i} style={{ color: "#fca5a5" }}>
                {v.path}: {v.message}
              </div>
            ))}
          <div style={{ color: "#94a3b8", margin: "6px 0" }}>装夹 {aiPlan.setups.length} · 工序 {aiPlan.process.order.length} · 刀具选择 {aiPlan.tool_choices.length}</div>
          {aiPlan.tool_choices.map((tc) => (
            <div key={tc.operation_type + tc.tool_id} style={{ color: "#e2e8f0", marginBottom: 2 }}>
              <span style={{ color: "#38bdf8", fontWeight: 600 }}>{tc.operation_type}</span> → {tc.tool_id}（score {tc.score.toFixed(2)}）
              <span style={{ color: "#64748b" }}> · {tc.reasons[0]}</span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid #1e293b", margin: "8px 0 6px", paddingTop: 6 }}>
            <div style={{ color: "#94a3b8", fontWeight: 600, marginBottom: 4 }}>变更预览（ChangeSet）</div>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#64748b", marginBottom: 2 }}>当前</div>
                {aiPlan.change_set.before ? (
                  <div style={{ color: "#e2e8f0" }}>{aiPlan.change_set.before.operation_count} 工序 · {aiPlan.change_set.before.tools.length} 刀具 · {aiPlan.change_set.before.setups.length} 装夹</div>
                ) : (
                  <div style={{ color: "#64748b" }}>（无 CAM 计划）</div>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#64748b", marginBottom: 2 }}>AI 方案</div>
                <div style={{ color: "#86efac" }}>{aiPlan.change_set.after.operation_count} 工序 · {aiPlan.change_set.after.tools.length} 刀具 · {aiPlan.change_set.after.setups.length} 装夹</div>
              </div>
            </div>
            {aiPlan.change_set.reasons.map((r, i) => (
              <div key={i} style={{ color: "#64748b", marginTop: 2 }}>
                · {r}
              </div>
            ))}
          </div>
          <button
            onClick={onApply}
            style={{ marginTop: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, background: "#16a34a", border: "none", color: "#fff", borderRadius: 6 }}
          >
            Apply 生成新 CAM 计划
          </button>
        </div>
      )}
      {aiPlans.length > 0 && (
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
          审计记录 {aiPlans.length} 条：
          {aiPlans.slice(0, 3).map((pl) => (
            <span key={pl.id} style={{ marginRight: 10 }}>
              [{pl.goal.slice(0, 8)}… {pl.model_route} · v{pl.prompt_version} · {pl.tool_calls.length} calls]
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
