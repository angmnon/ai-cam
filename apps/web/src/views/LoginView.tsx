/** 登录视图 */
import { useState } from "react";
import { api } from "../api.js";

export function LoginView({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState("engineer@test.local");
  const [password, setPassword] = useState("demo");
  const [org, setOrg] = useState("org_demo");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // P2-02：登录成功后端 Set-Cookie（HttpOnly），前端不再写 localStorage；
      // 响应体里的 token 仅供单测/脚本，浏览器会话由 cookie 维持。
      await api.login(email, password, org);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0f172a" }}>
      <form
        onSubmit={submit}
        style={{
          width: 360,
          padding: "32px 28px",
          borderRadius: 12,
          background: "#1e293b",
          border: "1px solid #334155",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          color: "#e2e8f0",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 20 }}>AI CNC CAM</h1>
        <p style={{ margin: 0, fontSize: 13, color: "#94a3b8" }}>Phase 1 · 零件解析流水线（演示登录）</p>
        <label style={{ fontSize: 13 }}>
          邮箱
          <input value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ fontSize: 13 }}>
          密码
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ fontSize: 13 }}>
          组织
          <input value={org} onChange={(e) => setOrg(e.target.value)} style={inputStyle} />
        </label>
        {error && <div style={{ fontSize: 13, color: "#f87171" }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ padding: "10px 0", cursor: "pointer", fontSize: 14, background: "#3b82f6", border: "none", color: "#fff", borderRadius: 8 }}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: 4,
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #334155",
  background: "#0f172a",
  color: "#e2e8f0",
  fontSize: 14,
};
