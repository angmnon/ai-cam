/** 上传/解析页：真实 STEP 上传 或 选择 Golden 示例零件（fixture 模式） */
import { useRef, useState } from "react";
import { api } from "../api.js";

export const GOLDEN_PARTS = [
  "box",
  "plate_with_hole",
  "plate_with_blind_hole",
  "pocket_block",
  "slot_block",
  "boss_block",
  "stepped_block",
  "circular_plate",
];

export function UploadView({ onAnalyzed }: { onAnalyzed: (partId: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [golden, setGolden] = useState(GOLDEN_PARTS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createAndAnalyze = async (filename: string, contentType: string, sizeBytes: number, upload?: ArrayBuffer) => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createPart({ filename, content_type: contentType, size_bytes: sizeBytes });
      const part = created.data.part;
      if (upload) {
        const s = created.data.upload_session;
        await api.uploadBytes(s.upload_url, s.headers, upload);
      }
      const analyzed = await api.analyzePart(part.id);
      onAnalyzed(analyzed.data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSubmitReal = async () => {
    if (!selectedFile) {
      setError("请选择 .step/.stp 文件");
      return;
    }
    const buf = await selectedFile.arrayBuffer();
    await createAndAnalyze(selectedFile.name, selectedFile.type || "model/step", selectedFile.size, buf);
  };

  const onSubmitGolden = () => {
    void createAndAnalyze(`${golden}.step`, "model/step", 1024);
  };

  return (
    <div style={{ height: "100%", padding: 32, boxSizing: "border-box", background: "#0f172a", color: "#e2e8f0", overflowY: "auto" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>CAD 上传与解析</h2>
      <p style={{ margin: "0 0 24px", fontSize: 13, color: "#94a3b8" }}>
        上传 STEP 文件（worker 模式）或选择 Golden 示例零件（fixture 模式，基于真实 OCCT 输出）。
      </p>

      <section style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>1. 上传 STEP 文件</h3>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            ref={fileRef}
            type="file"
            accept=".step,.stp"
            onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13, color: "#e2e8f0" }}
          />
          <button onClick={() => void onSubmitReal()} disabled={busy || !selectedFile} style={btnStyle}>
            {busy ? "解析中…" : "上传并解析"}
          </button>
        </div>
        {selectedFile && (
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>
            {selectedFile.name} · {(selectedFile.size / 1024).toFixed(1)} KB
          </div>
        )}
      </section>

      <section style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 20 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15 }}>2. 或使用 Golden 示例零件</h3>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <select value={golden} onChange={(e) => setGolden(e.target.value)} style={{ padding: "8px 10px", fontSize: 14, borderRadius: 6, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0" }}>
            {GOLDEN_PARTS.map((g) => (
              <option key={g} value={g}>
                {g}.step
              </option>
            ))}
          </select>
          <button onClick={() => void onSubmitGolden()} disabled={busy} style={btnStyle}>
            {busy ? "解析中…" : "解析示例"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
          示例：box / plate_with_hole（Ø20 通孔）/ plate_with_blind_hole（Ø16 盲孔）/ pocket_block / slot_block / boss_block / stepped_block / circular_plate
        </div>
      </section>

      {error && <div style={{ marginTop: 16, fontSize: 13, color: "#f87171" }}>解析失败：{error}</div>}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "9px 18px",
  cursor: "pointer",
  fontSize: 14,
  background: "#3b82f6",
  border: "none",
  color: "#fff",
  borderRadius: 8,
};
