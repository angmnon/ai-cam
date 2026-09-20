/** App：登录 → 上传/解析 → 零件面板 */
import { useState } from "react";
import { hasToken, setToken } from "./api.js";
import { LoginView } from "./views/LoginView.js";
import { UploadView } from "./views/UploadView.js";
import { PartView } from "./views/PartView.js";

type View = { name: "login" } | { name: "upload" } | { name: "part"; partId: string };

export function App() {
  const [view, setView] = useState<View>(hasToken() ? { name: "upload" } : { name: "login" });

  const logout = () => {
    setToken(null);
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
          <button onClick={logout} style={{ marginLeft: "auto", cursor: "pointer", background: "none", border: "none", color: "#64748b", fontSize: 13 }}>
            退出登录
          </button>
        </nav>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {view.name === "login" && <LoginView onLoggedIn={() => setView({ name: "upload" })} />}
        {view.name === "upload" && <UploadView onAnalyzed={(partId) => setView({ name: "part", partId })} />}
        {view.name === "part" && <PartView partId={view.partId} onBack={() => setView({ name: "upload" })} />}
      </div>
    </div>
  );
}
