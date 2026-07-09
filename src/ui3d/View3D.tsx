import { useEffect, useRef, type JSX } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fixtureViews, junctionPos, openingViews, type Pipeline } from "../core";
import { useApp } from "../state/store";

/**
 * The 3D view. Plan world (inches, y = north) maps to three.js as
 * x -> x, up -> y, north -> -z. Walls are elevation profiles (with door and
 * window holes) extruded by their thickness — no CSG.
 */

const DEFAULT_WALL_HEIGHT = 96;

const FIXTURE_HEIGHTS: Record<string, number> = {
  fridge: 66,
  range: 36,
  counter: 36,
  sink: 34,
  vanity: 34,
  toilet: 30,
  tub: 22,
  bed: 24,
  table: 30,
  island: 36,
};

function wallHeight(pipeline: Pipeline, wallKey: string): number {
  const eff = pipeline.resolved.effective.get(wallKey);
  if (eff?.expandedFrom !== undefined) {
    const room = pipeline.resolved.effective.get(eff.expandedFrom);
    if (room?.stmt.kind === "room" && room.stmt.height !== undefined) {
      return room.stmt.height.value / 64;
    }
  }
  return DEFAULT_WALL_HEIGHT;
}

function buildScene(pipeline: Pipeline, group: THREE.Group, selection: string | null): void {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xdfdbd0, roughness: 0.9 });
  const wallSelMat = new THREE.MeshStandardMaterial({ color: 0x93b4f8, roughness: 0.8 });
  const fixtureMat = new THREE.MeshStandardMaterial({ color: 0xaba79b, roughness: 0.7 });
  const fixtureSelMat = new THREE.MeshStandardMaterial({ color: 0x7c9cf0, roughness: 0.7 });

  const thickness = new Map<string, number>();
  for (const [key, eff] of pipeline.resolved.effective) {
    if (eff.stmt.kind === "walltype") thickness.set(key, eff.stmt.thickness / 64);
  }
  const opensByWall = new Map<string, ReturnType<typeof openingViews>>();
  for (const o of openingViews(pipeline)) {
    const list = opensByWall.get(o.wall) ?? [];
    list.push(o);
    opensByWall.set(o.wall, list);
  }

  for (const [key, eff] of pipeline.resolved.effective) {
    const s = eff.stmt;
    if (s.kind !== "wall") continue;
    const a = junctionPos(pipeline.solution, s.from);
    const b = junctionPos(pipeline.solution, s.to);
    if (a === null || b === null) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.5) continue;
    const height = wallHeight(pipeline, key);
    const th = thickness.get(s.wallType) ?? 4.5;

    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(len, 0);
    shape.lineTo(len, height);
    shape.lineTo(0, height);
    shape.closePath();

    for (const o of opensByWall.get(key) ?? []) {
      if (o.overflow) continue;
      const start = Math.hypot(o.jambA.x - a.x, o.jambA.y - a.y);
      const end = Math.hypot(o.jambB.x - a.x, o.jambB.y - a.y);
      const x0 = Math.min(start, end);
      const x1 = Math.max(start, end);
      const y0 = o.opKind === "door" ? 0 : o.sillInches;
      const y1 = Math.min(y0 + o.heightInches, height - 2);
      const hole = new THREE.Path();
      hole.moveTo(x0, y0);
      hole.lineTo(x1, y0);
      hole.lineTo(x1, y1);
      hole.lineTo(x0, y1);
      hole.closePath();
      shape.holes.push(hole);
    }

    const geo = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false });
    geo.translate(0, 0, -th / 2);
    const mesh = new THREE.Mesh(geo, selection === key ? wallSelMat : wallMat);
    mesh.position.set(a.x, 0, -a.y);
    mesh.rotation.y = Math.atan2((b.y - a.y) / len, (b.x - a.x) / len);
    mesh.userData.key = key;
    group.add(mesh);
  }

  for (const f of fixtureViews(pipeline)) {
    const h = FIXTURE_HEIGHTS[f.fixKind] ?? 30;
    const geo = new THREE.BoxGeometry(f.w, h, f.d);
    const mesh = new THREE.Mesh(geo, selection === f.key ? fixtureSelMat : fixtureMat);
    mesh.position.set(f.x, h / 2, -f.y);
    mesh.rotation.y = (f.rot * Math.PI) / 180;
    mesh.userData.key = f.key;
    group.add(mesh);
  }
}

function disposeGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) m.dispose();
    }
  }
}

export function View3D(): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pipeline = useApp((s) => s.pipeline);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);

  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    group: THREE.Group;
    raf: number;
    fitted: boolean;
  } | null>(null);

  // one-time init
  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      wrap.innerHTML = '<div class="plan-empty">WebGL unavailable</div>';
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio);
    wrap.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f3ec);
    scene.add(new THREE.AmbientLight(0xfffdf7, 0.7));
    const sun = new THREE.DirectionalLight(0xfff6e8, 1.3);
    sun.position.set(300, 500, 200);
    scene.add(sun);
    scene.add(new THREE.GridHelper(1600, 100, 0xd9d5c8, 0xe9e6dc));

    const camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
    camera.position.set(300, 260, 300);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Wheel is ours: two-finger scroll pans (like the 2D sheet); pinch
    // (ctrlKey wheel on macOS) or ⌘-scroll dollies.
    controls.enableZoom = false;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const offset = camera.position.clone().sub(controls.target);
        const dist = THREE.MathUtils.clamp(
          offset.length() * Math.exp(e.deltaY * 0.01),
          20,
          12000,
        );
        camera.position.copy(controls.target).add(offset.setLength(dist));
      } else {
        const dist = camera.position.distanceTo(controls.target);
        const perPx =
          (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) /
          Math.max(renderer.domElement.clientHeight, 1);
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        const pan = right
          .multiplyScalar(e.deltaX * perPx)
          .add(up.multiplyScalar(-e.deltaY * perPx));
        camera.position.add(pan);
        controls.target.add(pan);
      }
    };
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const group = new THREE.Group();
    scene.add(group);

    const state = { renderer, scene, camera, controls, group, raf: 0, fitted: false };
    sceneRef.current = state;

    const resize = (): void => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const loop = (): void => {
      controls.update();
      renderer.render(scene, camera);
      state.raf = requestAnimationFrame(loop);
    };
    loop();

    // click-to-select via raycast (ignore drags: check pointer travel)
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent): void => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent): void => {
      if (downAt === null) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(group.children, false);
      const key = hits[0]?.object.userData.key as string | undefined;
      select(key ?? null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    return () => {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      disposeGroup(group);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
    };
  }, [select]);

  // rebuild model on pipeline/selection change
  useEffect(() => {
    const state = sceneRef.current;
    if (state === null || pipeline === null) return;
    disposeGroup(state.group);
    buildScene(pipeline, state.group, selection);

    if (!state.fitted && state.group.children.length > 0) {
      state.fitted = true;
      const box = new THREE.Box3().setFromObject(state.group);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      state.controls.target.copy(center);
      state.camera.position.set(
        center.x + size * 0.7,
        size * 0.6,
        center.z + size * 0.7,
      );
    }
  }, [pipeline, selection]);

  return <div ref={wrapRef} className="view3d" />;
}
