import * as THREE from 'three';
import type { MarketState } from '@na/shared';
import {
  fetchCommissionBoard,
  fetchSession,
  fetchWorld,
  pollMarketState,
  pollSession,
  type CommissionBoardPayload,
  type SessionPayload,
  type WorldPayload,
} from './api.js';
import { FirstPersonController } from './controller.js';
import { GREYBOX } from './greybox.js';
import { createHud } from './hud.js';
import { buildLayout } from './layout.js';
import { buildScene, drawStallLabel, labelColors, setGateOpen, type LabelColors, type StallObject } from './scene.js';
import { PresentationLayer } from './presentation/index.js';
import { fetchPresentationConfig, initialMode, unconfirmedList } from './presentation/config.js';
import { isFirstPass } from '@na/shared';
import { stallMaterial } from './presentation/materials.js';
import { loadAssignedMeshes, MESH_TRIANGLE_BUDGET, type LoadedMesh } from './presentation/meshes.js';
import { assignedMeshSlots, type MaterialSlotId } from '@na/shared';

/**
 * M2: 歩けるグレイボックス・クライアント。
 * - 市場の値は M1 のサーバ状態だけを描く。クライアント側で市場を持たない。
 * - stall は config の stall_categories から並べる。固有名はサーバ経由で config から引く。
 * - 失敗は画面に出す。古い値を新しい値のように見せない。
 */

const MARKET_POLL_MS = 1000;
const SESSION_POLL_MS = 1000;
const BOARD_POLL_MS = 2000;
/** これを超えて更新が来なければ「更新停止」と表示する。 */
const STALE_AFTER_MS = 4000;

interface DebugHandle {
  stallCount: number;
  categoryIds: string[];
  marketSource: 'server';
  tick: number | null;
  averageFrameMs: number;
  fps: number;
  unconfirmedNames: string[];
  contextLost: () => boolean;
  renderMode: () => string;
  setRenderMode: (mode: 'greybox' | 'stylized') => void;
  assetsEnabled: () => boolean;
  setAssets: (on: boolean) => void;
  meshReport: () => { slot: string; triangles: number; reducedTriangles: number; placeholder: boolean }[];
  meshFailures: () => { slot: string; url: string; error: string }[];
  postPasses: () => string[];
  frameStats: () => { averageMs: number; budgetMs: number; exceeded: boolean };
  unconfirmedPresentation: () => string[];
  gates: () => { roomId: string; open: boolean; required: number; x: number; z: number }[];
  standing: () => number | null;
  stallPositions: { categoryId: string; x: number; z: number }[];
  moveTo(x: number, z: number): void;
  position: () => { x: number; z: number };
  focusedCategoryId: () => string | null;
}

declare global {
  interface Window {
    __na_debug?: DebugHandle;
  }
}

function showError(message: string): void {
  const box = document.querySelector<HTMLElement>('#error');
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
}

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#stage');
  const hudRoot = document.querySelector<HTMLElement>('#hud');
  const prompt = document.querySelector<HTMLElement>('#prompt');
  if (!canvas || !hudRoot || !prompt) throw new Error('必要な DOM 要素が無い');

  let world: WorldPayload;
  try {
    world = await fetchWorld();
  } catch (error) {
    showError(
      `world config を取得できない: ${(error as Error).message}\n` +
        'サーバ（M1）を起動しているか確認する: npm run dev:server',
    );
    throw error;
  }

  // 見た目は presentation config から差す。ソースに色や強度を持たない。
  const presentation = await fetchPresentationConfig();
  const colors = labelColors(presentation);

  // room（門）はサーバから来る。standing のしきい値も room 定義も config 由来。
  let session: SessionPayload | null = null;
  try {
    session = await fetchSession();
  } catch (error) {
    showError(`session を取得できない: ${(error as Error).message}`);
    throw error;
  }

  const layout = buildLayout(world.config.stall_categories);
  const gateSpecs = session.rooms
    .filter((room) => room.gate.required > 0)
    .map((room) => ({ roomId: room.id, label_ja: room.label_ja, required: room.gate.required }));
  const hud = createHud(hudRoot, world);

  // WebGL コンテキストが落ちたら黙って黒画面のままにしない。
  let contextLost = false;
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    showError('WebGL コンテキストが失われた。ページを再読み込みする必要がある');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
  });

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const layer = new PresentationLayer({
    config: presentation,
    renderer,
    mode: initialMode(presentation, window.location.search),
    headless: new URLSearchParams(window.location.search).get('headless') === '1',
    onBudgetExceeded: (message) => showError(`[performance] ${message}`),
  });
  const built = buildScene({ layout, gateSpecs, materials: layer.materials, presentation });

  // 生成メッシュ（割り当てがあれば）。マテリアルは stylized を掛ける（stylize-on-top）。
  const meshMaterialFor = (slot: MaterialSlotId): THREE.Material => {
    const set = layer.materials;
    switch (slot) {
      case 'floor': return set.floor;
      case 'wall': return set.wall;
      case 'stall': return set.stallWood;
      case 'counter': return set.counter;
      case 'gate': return set.gateClosed;
      default: return set.wall;
    }
  };
  let meshesBySlot = new Map<MaterialSlotId, LoadedMesh>();
  let meshFailures: { slot: string; url: string; error: string }[] = [];
  let assetsOn = assignedMeshSlots(presentation).length > 0;
  const reloadMeshes = async (): Promise<void> => {
    if (assignedMeshSlots(presentation).length === 0) {
      meshesBySlot = new Map();
      return;
    }
    const report = await loadAssignedMeshes(presentation, meshMaterialFor);
    meshesBySlot = new Map(report.loaded.map((m) => [m.slot, m]));
    meshFailures = report.failures;
    // 生成物が予算超過なら隠さず出す。
    for (const m of report.loaded) {
      if (m.reducedTriangles > MESH_TRIANGLE_BUDGET) {
        showError(`[assets] ${m.slot} が予算超過: ${m.reducedTriangles} > ${MESH_TRIANGLE_BUDGET} tri`);
      }
    }
    for (const f of report.failures) {
      showError(`[assets] ${f.slot} のメッシュを読めない: ${f.error}`);
    }
    built.applyMeshes(meshesBySlot, assetsOn);
  };
  await reloadMeshes();
  built.applyMeshes(meshesBySlot, assetsOn);

  const camera = new THREE.PerspectiveCamera(
    GREYBOX.camera.fov,
    window.innerWidth / window.innerHeight,
    GREYBOX.camera.near,
    GREYBOX.camera.far,
  );

  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    layer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  // greybox ↔ stylized のトグル。greybox 経路は消さない（比較・デバッグ用）。
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyP') {
      const next = layer.mode === 'greybox' ? 'stylized' : 'greybox';
      built.applyMaterials(layer.swapMode(next), focused?.slot.categoryId ?? null);
      // メッシュも新しいマテリアルへ差し直す（stylize-on-top を保つ）。
      for (const m of meshesBySlot.values()) {
        m.object.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.isMesh) mesh.material = meshMaterialFor(m.slot);
        });
      }
      return;
    }
    if (event.code === 'KeyM') {
      assetsOn = !assetsOn;
      built.applyMeshes(meshesBySlot, assetsOn);
    }
  });

  const controller = new FirstPersonController({
    camera,
    canvas,
    stalls: built.stalls,
    colliders: built.colliders,
    bounds: built.bounds,
    onLockChange: (locked) => {
      prompt.hidden = locked;
    },
  });

  const applySession = (next: SessionPayload): void => {
    session = next;
    for (const gate of built.gates) {
      const room = next.rooms.find((r) => r.id === gate.roomId);
      if (!room) throw new Error(`サーバに無い room: ${gate.roomId}`);
      setGateOpen(gate, room.gate.allowed, next.standing.score, layer.materials, colors);
    }
  };
  applySession(session);

  pollSession(
    SESSION_POLL_MS,
    (next) => applySession(next),
    (error) => showError(`session を取得できない: ${error.message}`),
  );

  // commission board（主モジュール）の状態。市場と同じくサーバが正。
  let board: CommissionBoardPayload | null = null;
  const refreshBoard = (): void => {
    void fetchCommissionBoard()
      .then((next) => {
        board = next;
      })
      .catch((error: unknown) => showError(`commission board を取得できない: ${(error as Error).message}`));
  };
  refreshBoard();
  window.setInterval(refreshBoard, BOARD_POLL_MS);

  let market: MarketState | null = null;
  let lastMarketAt = 0;
  for (const stall of built.stalls) drawStallLabel(stall, waitingLabel(stall), colors);

  pollMarketState(
    MARKET_POLL_MS,
    (state) => {
      market = state;
      lastMarketAt = performance.now();
      const box = document.querySelector<HTMLElement>('#error');
      if (box) box.hidden = true;
      for (const stall of built.stalls) drawStallLabel(stall, stallLabel(stall, state), colors);
    },
    (error) => {
      // 取得に失敗したら黙って前の値を使い続けない。画面に出す。
      showError(`market state を取得できない: ${error.message}`);
    },
  );

  let last = performance.now();
  let frameAccum = 0;
  let frameCount = 0;
  let fps = 0;
  let averageFrameMs = 0;
  let focused: StallObject | null = null;

  const frame = (now: number): void => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    controller.update(dt);
    const nextFocused = controller.focusedStall();
    if (nextFocused !== focused) {
      if (focused) focused.body.material = stallMaterial(layer.materials, focused.slot.direction, false);
      if (nextFocused) nextFocused.body.material = stallMaterial(layer.materials, nextFocused.slot.direction, true);
      focused = nextFocused;
    }

    const frameStart = performance.now();
    layer.render(built.scene, camera, now / 1000, dt * 1000);
    void frameStart;

    frameAccum += dt * 1000;
    frameCount += 1;
    if (frameCount >= 30) {
      averageFrameMs = frameAccum / frameCount;
      fps = averageFrameMs > 0 ? 1000 / averageFrameMs : 0;
      frameAccum = 0;
      frameCount = 0;
    }

    hud.update({
      presentation: {
        mode: layer.mode,
        passes: layer.passIds,
        stats: layer.stats(),
        unconfirmed: unconfirmedList(presentation),
        firstPass: isFirstPass(presentation),
        assets: {
          on: assetsOn,
          meshes: meshesBySlot.size,
          placeholders: [...meshesBySlot.values()].filter((m) => m.placeholder).length,
          failures: meshFailures.length,
        },
      },
      world,
      session,
      board,
      market,
      focused,
      fps,
      frameMs: averageFrameMs,
      stale: market !== null && performance.now() - lastMarketAt > STALE_AFTER_MS,
    });

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  window.__na_debug = {
    stallCount: built.stalls.length,
    categoryIds: built.stalls.map((s) => s.slot.categoryId),
    marketSource: 'server',
    get tick() {
      return market?.tick ?? null;
    },
    get averageFrameMs() {
      return averageFrameMs;
    },
    get fps() {
      return fps;
    },
    unconfirmedNames: world.unconfirmedNames,
    contextLost: () => contextLost,
    renderMode: () => layer.mode,
    setRenderMode: (mode) => {
      const materials = layer.swapMode(mode);
      built.applyMaterials(materials, focused?.slot.categoryId ?? null);
    },
    assetsEnabled: () => assetsOn,
    setAssets: (on: boolean) => {
      assetsOn = on;
      built.applyMeshes(meshesBySlot, assetsOn);
    },
    meshReport: () =>
      [...meshesBySlot.values()].map((m) => ({
        slot: m.slot,
        triangles: m.triangles,
        reducedTriangles: m.reducedTriangles,
        placeholder: m.placeholder,
      })),
    meshFailures: () => meshFailures,
    postPasses: () => layer.passIds,
    frameStats: () => layer.stats(),
    unconfirmedPresentation: () => unconfirmedList(presentation),
    gates: () =>
      built.gates.map((g) => ({
        roomId: g.roomId,
        open: g.open,
        required: g.required,
        x: g.door.position.x,
        z: g.door.position.z,
      })),
    standing: () => session?.standing.score ?? null,
    stallPositions: built.stalls.map((s) => ({ categoryId: s.slot.categoryId, x: s.slot.x, z: s.slot.z })),
    moveTo: (x: number, z: number) => {
      controller.setInput([]);
      controller.teleport(x, z);
    },
    position: () => {
      const p = controller.playerPosition;
      return { x: p.x, z: p.z };
    },
    focusedCategoryId: () => focused?.slot.categoryId ?? null,
  } as DebugHandle;
}

function waitingLabel(stall: StallObject): { title: string; price: string; stock: string; shock: boolean } {
  return { title: stall.slot.label_ja, price: 'price —', stock: 'stock —', shock: false };
}

function stallLabel(
  stall: StallObject,
  state: MarketState,
): { title: string; price: string; stock: string; shock: boolean } {
  const line = state.states.find((s) => s.itemId === stall.slot.categoryId);
  if (!line) return waitingLabel(stall);
  return {
    title: stall.slot.label_ja,
    price: `price ${line.price.toFixed(1)}`,
    stock: `stock ${Math.round(line.stock)}`,
    shock: line.shock !== null,
  };
}

void main().catch((error: unknown) => {
  showError(`起動に失敗: ${(error as Error).message}`);
});
