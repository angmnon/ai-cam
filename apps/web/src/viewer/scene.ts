/**
 * Viewer 场景工厂：支持服务端 tessellation（OBJ / VIEW_MESH）与特征包围盒渲染。
 * 坐标系约定：three.js Y-up；STEP/几何数据 Z-up → 加载 OBJ 时旋转 -90° 绕 X 轴。
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

export interface ViewerFeatureBox {
  id: string;
  type: string;
  confidence: number;
  bbox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

/** 刀路叠加输入（CamIR.toolpaths 子集） */
export interface ViewerToolpath {
  operation_id: string;
  moves: Array<{ type: string; x: number; y: number; z: number }>;
}

export interface ViewerScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  partGroup: THREE.Group;
  dispose(): void;
}

const FEATURE_COLORS: Record<string, number> = {
  HOLE_THROUGH: 0x38bdf8,
  HOLE_BLIND: 0x22d3ee,
  POCKET: 0xf59e0b,
  OPEN_POCKET: 0xfbbf24,
  SLOT: 0xf97316,
  BOSS: 0x34d399,
  STEP: 0x818cf8,
  OUTER_PROFILE: 0x94a3b8,
  CHAMFER: 0xf472b6,
  PLANAR_FACE: 0x94a3b8,
};

export function createViewerScene(container: HTMLElement): ViewerScene {
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 5000);
  camera.position.set(150, 130, 170);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 20, 0);
  controls.enableDamping = true;
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(120, 180, 100);
  scene.add(dir);
  const rim = new THREE.DirectionalLight(0x93c5fd, 0.4);
  rim.position.set(-100, 40, -80);
  scene.add(rim);

  const grid = new THREE.GridHelper(300, 20, 0x334155, 0x1e293b);
  scene.add(grid);
  const axes = new THREE.AxesHelper(80);
  scene.add(axes);

  const partGroup = new THREE.Group();
  scene.add(partGroup);

  let raf = 0;
  const animate = () => {
    raf = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const onResize = () => {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", onResize);

  return {
    scene,
    camera,
    renderer,
    controls,
    partGroup,
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
        }
        if (obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** 清空零件组（网格与特征盒） */
export function clearPartGroup(scene: ViewerScene): void {
  while (scene.partGroup.children.length > 0) {
    const child = scene.partGroup.children[0];
    scene.partGroup.remove(child);
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose());
    }
  }
}

/** 从 URL 加载 OBJ（Z-up → Y-up 旋转）并自动对中/适配视角 */
export async function loadObjFromUrl(scene: ViewerScene, url: string): Promise<THREE.Group> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mesh fetch failed: ${res.status}`);
  const text = await res.text();
  const loader = new OBJLoader();
  const obj = loader.parse(text);
  obj.rotation.x = -Math.PI / 2; // STEP Z-up → three Y-up
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        metalness: 0.35,
        roughness: 0.4,
        flatShading: true,
      });
      child.material.side = THREE.DoubleSide;
    }
  });
  scene.partGroup.add(obj);
  fitView(scene, obj);
  return obj;
}

/** 特征包围盒线框（叠加在零件网格上） */
export function addFeatureBoxes(scene: ViewerScene, features: ViewerFeatureBox[]): void {  const dirs: Array<[number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const f of features) {
    const b = f.bbox;
    const size = new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    const center = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    const color = FEATURE_COLORS[f.type] ?? 0xffffff;
    const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
    const edges = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
    );
    line.position.copy(center);
    scene.partGroup.add(line);

    // 方向指示线（可访问方向）
    const axLen = Math.max(size.x, size.y, size.z) * 0.35 + 4;
    for (const d of dirs) {
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(...d), center, axLen, color, axLen * 0.16, axLen * 0.08);
      scene.partGroup.add(arrow);
    }
  }
}

/** 按包围盒适配相机视角 */
export function fitView(scene: ViewerScene, target: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(target);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 1) * 1.8;
  scene.camera.position.set(center.x + radius * 0.9, center.y + radius * 0.8, center.z + radius);
  scene.controls.target.copy(center);
  scene.controls.update();
}

export function triangleCount(obj: THREE.Object3D): number {
  let count = 0;
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const g = child.geometry;
      count += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
  });
  return Math.round(count);
}

/** 刀路叠加：每个 op 一条折线（跳过 RAPID 快速移动；Z-up → three Y-up 旋转） */
const TP_OP_COLORS: Record<string, number> = {
  FACE: 0x38bdf8,
  POCKET: 0xf59e0b,
  DRILL: 0x34d399,
  CONTOUR: 0xf472b6,
  CHAMFER: 0xfbbf24,
  ADAPTIVE_ROUGH: 0xf97316,
};

export function addToolpathLines(scene: ViewerScene, toolpaths: ViewerToolpath[]): THREE.Group {
  const group = new THREE.Group();
  for (const tp of toolpaths) {
    const pts: THREE.Vector3[] = [];
    for (const m of tp.moves) {
      if (m.type === "RAPID") continue; // 不画快速移动
      pts.push(new THREE.Vector3(m.x, m.y, m.z));
    }
    if (pts.length < 2) continue;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const opType = tp.operation_id.split("_")[0].toUpperCase();
    const color = TP_OP_COLORS[opType] ?? 0x94a3b8;
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
    );
    line.rotation.x = -Math.PI / 2; // STEP Z-up → three Y-up
    group.add(line);
  }
  if (group.children.length > 0) {
    group.name = "toolpaths";
    scene.partGroup.add(group);
  }
  return group;
}
