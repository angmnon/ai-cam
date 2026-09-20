/** Viewer 组件：加载 OBJ 网格 + 特征包围盒 + DFM 高亮 */
import { useEffect, useRef, useState } from "react";
import {
  addFeatureBoxes,
  clearPartGroup,
  createViewerScene,
  fitView,
  loadObjFromUrl,
  triangleCount,
  type ViewerFeatureBox,
  type ViewerScene,
} from "./scene.js";

export interface ViewerData {
  meshUrl?: string;
  features?: ViewerFeatureBox[];
  partBBox?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

export interface ViewerHandle {
  setWireframe(on: boolean): void;
  setAutoRotate(on: boolean): void;
  resetView(): void;
  getTriangleCount(): number;
}

export function Viewer({ data }: { data?: ViewerData | null }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
  const handleRef = useRef<ViewerHandle | null>(null);
  const [wireframe, setWireframeState] = useState(false);
  const [autoRotate, setAutoRotateState] = useState(false);
  const [triangles, setTriangles] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = createViewerScene(mount);
    sceneRef.current = scene;
    handleRef.current = {
      setWireframe(on) {
        scene.partGroup.traverse((obj) => {
          const mesh = obj as { isMesh?: boolean; material?: { wireframe?: boolean } };
          if (mesh.isMesh && mesh.material) mesh.material.wireframe = on;
        });
        scene.renderer.render(scene.scene, scene.camera);
      },
      setAutoRotate(on) {
        scene.controls.autoRotate = on;
        scene.controls.autoRotateSpeed = 2;
      },
      resetView() {
        scene.camera.position.set(150, 130, 170);
        scene.controls.target.set(0, 20, 0);
        scene.controls.update();
      },
      getTriangleCount() {
        return triangleCount(scene.partGroup);
      },
    };
    return () => scene.dispose();
  }, []);

  // 数据变化 → 重建场景内容
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !data) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      clearPartGroup(scene);
      try {
        if (data.meshUrl) {
          const obj = await loadObjFromUrl(scene, data.meshUrl);
          if (!cancelled) {
            if (data.features?.length) addFeatureBoxes(scene, data.features);
            setTriangles(triangleCount(obj));
          }
        } else if (data.features?.length) {
          addFeatureBoxes(scene, data.features);
          setTriangles(0);
        } else if (data.partBBox) {
          const b = data.partBBox;
          const size = { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
          const geo = new (await import("three")).BoxGeometry(size.x, size.y, size.z);
          const edges = new (await import("three")).EdgesGeometry(geo);
          const line = new (await import("three")).LineSegments(edges, new (await import("three")).LineBasicMaterial({ color: 0x64748b }));
          line.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
          scene.partGroup.add(line);
          fitView(scene, line);
          setTriangles(0);
        }
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          console.error("viewer load failed", e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0f172a", color: "#e2e8f0" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderBottom: "1px solid #1e293b" }}>
        <strong style={{ fontSize: 15 }}>3D 零件视图</strong>
        <span style={{ fontSize: 13, color: "#94a3b8" }}>
          {loading ? "加载中…" : data?.meshUrl ? "网格（VIEW_MESH） + 特征包围盒" : "特征包围盒（示意）"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={wireframe} onChange={() => { const n = !wireframe; setWireframeState(n); handleRef.current?.setWireframe(n); }} /> 线框
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={autoRotate} onChange={() => { const n = !autoRotate; setAutoRotateState(n); handleRef.current?.setAutoRotate(n); }} /> 自动旋转
          </label>
          <button style={{ fontSize: 13, padding: "4px 12px", cursor: "pointer" }} onClick={() => handleRef.current?.resetView()}>重置视角</button>
          <span style={{ fontSize: 12, color: "#64748b" }}>三角面 {triangles.toLocaleString()}</span>
        </div>
      </header>
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
