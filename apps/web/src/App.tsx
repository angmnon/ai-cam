/** App：登录 → 上传/解析 → 零件面板 */
import { useState } from "react";
import { logout } from "./api.js";
import { LoginView } from "./views/LoginView.js";
import { UploadView } from "./views/UploadView.js";
import { PartView } from "./views/PartView.js";

type View = { name: "login" } | { name: "upload" } | { name: "part"; partId: string };

export function App() {
  // P2-02：HttpOnly cookie JS 不可读，无法在首载时探测会话；一律走登录页，登录成功后 onLoggedIn 推进。
  const [view, setView] = useState<View>({ name: "login" });
  const [mode, setMode] = useState<"expert" | "shopfloor">("expert");

  const handleLogout = async () => {
    await logout();
    setView({ name: "login" });
  };

  return (
    <div style={{ height: "100vh", width: "100vw", margin: 0, fontFamily: "'Microsoft YaHei', system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      {view.name !== "login" && (
        <nav style={{ display: "flex", alignItems: "center", gap: 16, padding: "8px 20px", borderBottom: "1px solid #1e293b", background: "#0b1220", color: "#e2e8f0", fontSize: 13 }}>
          <strong style={{ fontSize: 15 }}>AI CNC CAM</strong>
          <button
            onClick={() => setView({ name: "upload" })}
            style={{ cursor: "pointer", background: "none", border: "none", color: view.name === "upload" ? "#38bdf8" : "#94a3b8", fontSize: 13 }}
          >
            上传/解析
          </button>
          {view.name === "part" && (
            <span style={{ color: "#38bdf8" }}>零件面板</span>
          )}
          <button
            onClick={() => setMode(mode === "expert" ? "shopfloor" : "expert")}
            style={{ marginLeft: "auto", cursor: "pointer", padding: "4px 12px", fontSize: 12, background: mode === "expert" ? "#334155" : "#7c3aed", border: "1px solid #475569", borderRadius: 999, color: mode === "expert" ? "#e2e8f0" : "#fff" }}
            title="Expert：完整工艺信息；Shop Floor：机床操作简化视图"
          >
            {mode === "expert" ? "专家模式" : "车间模式"}
          </button>
          <button onClick={handleLogout} style={{ cursor: "pointer", background: "none", border: "none", color: "#64748b", fontSize: 13 }}>
            退出登录
          </button>
        </nav>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {view.name === "login" && <LoginView onLoggedIn={() => setView({ name: "upload" })} />}
        {view.name === "upload" && <UploadView onAnalyzed={(partId) => setView({ name: "part", partId })} />}
        {view.name === "part" && <PartView partId={view.partId} mode={mode} onBack={() => setView({ name: "upload" })} />}
      </div>
    </div>
  );
}
