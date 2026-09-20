/**
 * Viewer 场景工厂：构建示例零件（示意）、灯光、网格、坐标轴与相机。
 * 后续接入：服务端 tessellation（GLB / VIEW_MESH）→ loadPartMesh() 替换示例。
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface ViewerScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  partGroup: THREE.Group;
  mesh: THREE.Mesh;
  dispose(): void;
}

/** 构建示例零件：基座 + 凸台 + 顶部定位孔（示意，非真实 CAD 数据） */
export function buildDemoPart(): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.35, roughness: 0.35, flatShading: true });
  const matAccent = new THREE.MeshStandardMaterial({ color: 0x3b82f6, metalness: 0.3, roughness: 0.4, flatShading: true });

  const base = new THREE.Mesh(new THREE.BoxGeometry(80, 16, 50), mat);
  base.position.y = 8;
  group.add(base);

  const boss = new THREE.Mesh(new THREE.BoxGeometry(36, 22, 26), mat);
  boss.position.set(-8, 27, 0);
  group.add(boss);

  const pad = new THREE.Mesh(new THREE.BoxGeometry(18, 10, 18), matAccent);
  pad.position.set(24, 21, -6);
  group.add(pad);

  const hole = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 4, 32), matAccent);
  hole.position.set(-8, 34.5, 0);
  hole.rotation.x = Math.PI / 2;
  group.add(hole);

  return group;
}

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
  controls.target.set(0, 24, 0);
  controls.enableDamping = true;
  controls.update();

  // 灯光
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(120, 180, 100);
  scene.add(dir);
  const rim = new THREE.DirectionalLight(0x93c5fd, 0.4);
  rim.position.set(-100, 40, -80);
  scene.add(rim);

  // 网格与坐标轴
  const grid = new THREE.GridHelper(300, 20, 0x334155, 0x1e293b);
  scene.add(grid);
  const axes = new THREE.AxesHelper(80);
  scene.add(axes);

  // 示例零件
  const partGroup = new THREE.Group();
  partGroup.add(buildDemoPart());
  scene.add(partGroup);
  const mesh = partGroup.children[0] as THREE.Mesh;

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
    mesh,
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
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
