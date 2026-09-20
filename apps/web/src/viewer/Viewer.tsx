/** Viewer React 组件：挂载 three 场景，暴露线框/自动旋转/重置视图控制 */
import { useEffect, useRef, useState } from "react";
import { createViewerScene, triangleCount, type ViewerScene } from "./scene.js";

export interface ViewerHandle {
  setWireframe(on: boolean): void;
  setAutoRotate(on: boolean): void;
  resetView(): void;
  getTriangleCount(): number;
}

export function Viewer() {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);
  const handleRef = useRef<ViewerHandle | null>(null);
  const [wireframe, setWireframeState] = useState(false);
  const [autoRotate, setAutoRotateState] = useState(false);
  const [triangles, setTriangles] = useState(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = createViewerScene(mount);
    sceneRef.current = scene;
    setTriangles(triangleCount(scene.partGroup));

    handleRef.current = {
      setWireframe(on) {
        scene.partGroup.traverse((obj) => {
          const mesh = obj as { isMesh?: boolean; material?: { wireframe?: boolean } };
          if (mesh.isMesh && mesh.material) {
            mesh.material.wireframe = on;
          }
        });
        scene.renderer.render(scene.scene, scene.camera);
      },
      setAutoRotate(on) {
        scene.controls.autoRotate = on;
        scene.controls.autoRotateSpeed = 2;
      },
      resetView() {
        scene.camera.position.set(150, 130, 170);
        scene.controls.target.set(0, 24, 0);
        scene.controls.update();
      },
      getTriangleCount() {
        return triangleCount(scene.partGroup);
      },
    };
    return () => scene.dispose();
  }, []);

  const onWireframe = () => {
    const next = !wireframe;
    setWireframeState(next);
    handleRef.current?.setWireframe(next);
  };
  const onAutoRotate = () => {
    const next = !autoRotate;
    setAutoRotateState(next);
    handleRef.current?.setAutoRotate(next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0f172a", color: "#e2e8f0" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderBottom: "1px solid #1e293b" }}>
        <strong style={{ fontSize: 15 }}>AI CNC CAM — 3D Viewer</strong>
        <span style={{ fontSize: 13, color: "#94a3b8" }}>Phase 0 骨架 · 示例零件（示意）</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={wireframe} onChange={onWireframe} /> 线框
          </label>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={autoRotate} onChange={onAutoRotate} /> 自动旋转
          </label>
          <button
            style={{ fontSize: 13, padding: "4px 12px", cursor: "pointer" }}
            onClick={() => handleRef.current?.resetView()}
          >
            重置视角
          </button>
          <span style={{ fontSize: 12, color: "#64748b" }}>三角面 {triangles.toLocaleString()}</span>
        </div>
      </header>
      <div ref={mountRef} style={{ flex: 1, minHeight: 0 }} />
      <footer style={{ padding: "6px 16px", borderTop: "1px solid #1e293b", fontSize: 12, color: "#64748b" }}>
        后续接入：上传 STEP → geometry-worker 服务端 tessellation → GLB / VIEW_MESH 加载（Phase 1）。
      </footer>
    </div>
  );
}
