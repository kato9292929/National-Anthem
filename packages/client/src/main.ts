import * as THREE from 'three';
import type { MarketState } from '@na/shared';
import { fetchSession, fetchWorld, pollMarketState, pollSession, type SessionPayload, type WorldPayload } from './api.js';
import { FirstPersonController } from './controller.js';
import { GREYBOX } from './greybox.js';
import { createHud } from './hud.js';
import { buildLayout } from './layout.js';
import { buildScene, drawStallLabel, setGateOpen, type StallObject } from './scene.js';

/**
 * M2: 歩けるグレイボックス・クライアント。
 * - 市場の値は M1 のサーバ状態だけを描く。クライアント側で市場を持たない。
 * - stall は config の stall_categories から並べる。固有名はサーバ経由で config から引く。
 * - 失敗は画面に出す。古い値を新しい値のように見せない。
 */

const MARKET_POLL_MS = 1000;
const SESSION_POLL_MS = 1000;
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
  const built = buildScene(layout, gateSpecs);
  const hud = createHud(hudRoot, world);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const camera = new THREE.PerspectiveCamera(
    GREYBOX.camera.fov,
    window.innerWidth / window.innerHeight,
    GREYBOX.camera.near,
    GREYBOX.camera.far,
  );

  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

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
      setGateOpen(gate, room.gate.allowed, next.standing.score);
    }
  };
  applySession(session);

  pollSession(
    SESSION_POLL_MS,
    (next) => applySession(next),
    (error) => showError(`session を取得できない: ${error.message}`),
  );

  let market: MarketState | null = null;
  let lastMarketAt = 0;
  for (const stall of built.stalls) drawStallLabel(stall, waitingLabel(stall));

  pollMarketState(
    MARKET_POLL_MS,
    (state) => {
      market = state;
      lastMarketAt = performance.now();
      const box = document.querySelector<HTMLElement>('#error');
      if (box) box.hidden = true;
      for (const stall of built.stalls) drawStallLabel(stall, stallLabel(stall, state));
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
      if (focused) focused.body.material.color.setHex(colorFor(focused));
      if (nextFocused) nextFocused.body.material.color.setHex(GREYBOX.color.highlight);
      focused = nextFocused;
    }

    renderer.render(built.scene, camera);

    frameAccum += dt * 1000;
    frameCount += 1;
    if (frameCount >= 30) {
      averageFrameMs = frameAccum / frameCount;
      fps = averageFrameMs > 0 ? 1000 / averageFrameMs : 0;
      frameAccum = 0;
      frameCount = 0;
    }

    hud.update({
      world,
      session,
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

function colorFor(stall: StallObject): number {
  return stall.slot.direction === 'import' ? GREYBOX.color.stallImport : GREYBOX.color.stallExport;
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
