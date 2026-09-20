/** 仿真播放器（P3-4）：体素快照 → Canvas 俯视投影，时间轴可播放/步进/点击关联 */
import { useEffect, useRef, useState } from "react";
import type { SimFrame } from "../api.js";

const CANVAS_W = 260;
const CANVAS_H = 200;

export function SimPlayer({ frames, partBBox }: { frames: SimFrame[]; partBBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setIdx(0);
  }, [frames]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const frame = frames[Math.min(idx, frames.length - 1)];
    // 俯视投影：x 右、y 上；solid 点按 z 高度着色（深→浅表示剩余材料高度）
    const b = partBBox;
    const spanX = Math.max(1e-6, b.max.x - b.min.x);
    const spanY = Math.max(1e-6, b.max.y - b.min.y);
    const pad = 14;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    const zMin = b.min.z;
    const zSpan = Math.max(1e-6, b.max.z - b.min.z);
    const cells = new Map<string, number>();
    for (const p of frame.snapshot) {
      if (!p.solid) continue;
      const cx = Math.round(((p.x - b.min.x) / spanX) * 40);
      const cy = Math.round(((p.y - b.min.y) / spanY) * 40);
      const key = `${cx}|${cy}`;
      const h = (p.z - zMin) / zSpan;
      const prev = cells.get(key) ?? 0;
      cells.set(key, Math.max(prev, h));
    }
    for (const [key, h] of cells) {
      const [cx, cy] = key.split("|").map(Number);
      const px = pad + (cx / 40) * (CANVAS_W - pad * 2);
      const py = CANVAS_H - pad - (cy / 40) * (CANVAS_H - pad * 2);
      const light = Math.round(70 + h * 160);
      ctx.fillStyle = `rgb(${light}, ${Math.round(light * 0.85)}, ${Math.round(light * 0.6)})`;
      const s = (CANVAS_W - pad * 2) / 40;
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
    }
    ctx.strokeStyle = "#1e293b";
    ctx.strokeRect(pad - 0.5, pad - 0.5, CANVAS_W - pad * 2 + 1, CANVAS_H - pad * 2 + 1);
    ctx.fillStyle = "#64748b";
    ctx.font = "10px sans-serif";
    ctx.fillText(`Frame ${idx + 1}/${frames.length}`, 6, 12);
  }, [frames, idx, partBBox]);

  useEffect(() => {
    if (playing) {
      timerRef.current = window.setInterval(() => {
        setIdx((i) => (i + 1) % Math.max(1, frames.length));
      }, 700);
    }
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [playing, frames.length]);

  if (frames.length === 0) return <div style={{ fontSize: 12, color: "#64748b" }}>无仿真帧数据。</div>;

  return (
    <div>
      <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} style={{ width: "100%", borderRadius: 8, border: "1px solid #1e293b", background: "#0b1220" }} />
      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
        <button onClick={() => setPlaying(!playing)} style={{ padding: "4px 12px", cursor: "pointer", fontSize: 12, background: "#3b82f6", border: "none", color: "#fff", borderRadius: 6 }}>
          {playing ? "暂停" : "播放"}
        </button>
        <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} style={{ padding: "4px 10px", cursor: "pointer", fontSize: 12, background: "#334155", border: "none", color: "#e2e8f0", borderRadius: 6 }}>
          ←
        </button>
        <button onClick={() => setIdx((i) => Math.min(frames.length - 1, i + 1))} disabled={idx >= frames.length - 1} style={{ padding: "4px 10px", cursor: "pointer", fontSize: 12, background: "#334155", border: "none", color: "#e2e8f0", borderRadius: 6 }}>
          →
        </button>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>{frames[idx]?.operation_id}</span>
      </div>
    </div>
  );
}
