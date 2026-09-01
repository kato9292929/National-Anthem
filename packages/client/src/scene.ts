import * as THREE from 'three';
import type { PresentationConfig } from '@na/shared';
import { GREYBOX } from './greybox.js';
import type { MarketLayout, StallSlot } from './layout.js';
import { cssColor } from './presentation/config.js';
import { stallMaterial, type MaterialSet } from './presentation/materials.js';

/** 看板に描く色。presentation config から作る（ここに色を書かない）。 */
export interface LabelColors {
  background: string;
  border: string;
  borderShock: string;
  borderOpen: string;
  borderClosed: string;
  title: string;
  body: string;
  open: string;
  closed: string;
}

export function labelColors(config: PresentationConfig): LabelColors {
  return {
    background: cssColor(config, 'labelBackground'),
    border: cssColor(config, 'labelBorder'),
    borderShock: cssColor(config, 'labelBorderShock'),
    borderOpen: cssColor(config, 'labelBorderOpen'),
    borderClosed: cssColor(config, 'labelBorderClosed'),
    title: cssColor(config, 'labelTitle'),
    body: cssColor(config, 'labelBody'),
    open: cssColor(config, 'labelOpen'),
    closed: cssColor(config, 'labelClosed'),
  };
}

/**
 * グレイボックスの市場空間。無地の床・壁・箱だけ。
 * テクスチャもモデルも読み込まない（presentation は範囲外）。
 */

export interface StallObject {
  slot: StallSlot;
  group: THREE.Group;
  body: THREE.Mesh<THREE.BoxGeometry, THREE.Material>;
  counter: THREE.Mesh<THREE.BoxGeometry, THREE.Material>;
  label: THREE.Sprite;
  labelCanvas: HTMLCanvasElement;
  labelTexture: THREE.CanvasTexture;
  /** 当たり判定（XZ 平面の矩形）。 */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** standing で開閉する門。閉じている間は当たり判定が有効。 */
export interface GateObject {
  roomId: string;
  label_ja: string;
  required: number;
  door: THREE.Mesh<THREE.BoxGeometry, THREE.Material>;
  label: THREE.Sprite;
  labelCanvas: HTMLCanvasElement;
  labelTexture: THREE.CanvasTexture;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  open: boolean;
}

export interface Collider {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  isSolid(): boolean;
}

export interface BuiltScene {
  scene: THREE.Scene;
  stalls: StallObject[];
  gates: GateObject[];
  colliders: Collider[];
  bounds: { halfWidth: number; halfDepth: number };
  /** モードを切り替えたときに、同じ形へマテリアルだけ差し直す。 */
  applyMaterials(materials: MaterialSet, focusedStallId: string | null): void;
}

/** 門が要る room（standing のしきい値がある room）だけを門にする。 */
export interface GateSpec {
  roomId: string;
  label_ja: string;
  required: number;
}

export interface BuildSceneInput {
  layout: MarketLayout;
  gateSpecs?: GateSpec[];
  materials: MaterialSet;
  presentation: PresentationConfig;
}

export function buildScene(input: BuildSceneInput): BuiltScene {
  const { layout, materials, presentation } = input;
  const gateSpecs = input.gateSpecs ?? [];
  const colors = labelColors(presentation);

  const scene = new THREE.Scene();
  scene.background = colorOf(presentation, 'sky');
  scene.fog = new THREE.Fog(
    colorOf(presentation, 'fog').getHex(),
    presentation.lighting.fogNear,
    presentation.lighting.fogFar,
  );

  scene.add(
    new THREE.HemisphereLight(
      colorOf(presentation, 'lightSky'),
      colorOf(presentation, 'lightGround'),
      presentation.lighting.ambientIntensity,
    ),
  );
  const key = new THREE.DirectionalLight(colorOf(presentation, 'lightKey'), presentation.lighting.keyIntensity);
  key.position.set(6, 14, 8);
  scene.add(key);

  const width = layout.halfWidth * 2;
  const depth = layout.halfDepth * 2;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), materials.floor);
  const walls: THREE.Mesh[] = [];
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const wallMaterial = materials.wall;
  const { wallHeight: h, wallThickness: t } = GREYBOX.space;
  const wallSpecs: [number, number, number, number, number][] = [
    [width + t, h, t, 0, -layout.halfDepth],
    [width + t, h, t, 0, layout.halfDepth],
    [t, h, depth + t, -layout.halfWidth, 0],
    [t, h, depth + t, layout.halfWidth, 0],
  ];
  for (const [w, hh, d, x, z] of wallSpecs) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), wallMaterial);
    wall.position.set(x, hh / 2, z);
    scene.add(wall);
    walls.push(wall);
  }

  const stalls = layout.slots.map((slot) => buildStall(slot, materials, colors));
  for (const stall of stalls) {
    scene.add(stall.group);
    // 看板はワールド座標に置く（group は回転しているので入れ子にしない）。
    scene.add(stall.label);
  }

  const { gates, partitions, partitionMeshes } = buildPartition(scene, layout, gateSpecs, wallMaterial, materials, colors);

  const colliders: Collider[] = [
    ...stalls.map((stall) => ({ bounds: stall.bounds, isSolid: () => true })),
    ...partitions.map((bounds) => ({ bounds, isSolid: () => true })),
    ...gates.map((gate) => ({ bounds: gate.bounds, isSolid: () => !gate.open })),
  ];

  return {
    scene,
    stalls,
    gates,
    colliders,
    bounds: { halfWidth: layout.halfWidth, halfDepth: layout.halfDepth },
    applyMaterials: (next, focusedStallId) => {
      floor.material = next.floor;
      for (const wall of [...walls, ...partitionMeshes]) wall.material = next.wall;
      for (const stall of stalls) {
        stall.body.material = stallMaterial(next, stall.slot.direction, stall.slot.categoryId === focusedStallId);
        stall.counter.material = next.counter;
      }
      for (const gate of gates) gate.door.material = gate.open ? next.gateOpen : next.gateClosed;
    },
  };
}

/**
 * 内側の区画を仕切る壁と、その開口に立つ門を作る。
 * 門の数と位置は room の数から決まる（room が増えても並びが伸縮する）。
 */
function buildPartition(
  scene: THREE.Scene,
  layout: MarketLayout,
  specs: GateSpec[],
  wallMaterial: THREE.Material,
  materials: MaterialSet,
  colors: LabelColors,
): {
  gates: GateObject[];
  partitions: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  partitionMeshes: THREE.Mesh[];
} {
  const gates: GateObject[] = [];
  const partitions: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  const partitionMeshes: THREE.Mesh[] = [];
  if (specs.length === 0) return { gates, partitions, partitionMeshes };

  const g = GREYBOX.gate;
  const z = -layout.halfDepth + g.partitionOffsetZ;

  // 開口は通路の内側にだけ作る。stall の列と重なると門まで歩けない。
  const aisleHalf = GREYBOX.space.aisleWidth / 2 - GREYBOX.stall.depth / 2;
  const step = (aisleHalf * 2) / (specs.length + 1);
  const openings = specs.map((spec, index) => ({ spec, x: -aisleHalf + step * (index + 1) }));
  const needed = specs.length * g.doorWidth;
  if (needed > aisleHalf * 2) {
    throw new Error(`門 ${specs.length} 枚が通路に収まらない（必要 ${needed}m / 通路 ${aisleHalf * 2}m）`);
  }

  // 開口以外を壁で埋める。
  const edges = [-layout.halfWidth, ...openings.flatMap((o) => [o.x - g.doorWidth / 2, o.x + g.doorWidth / 2]), layout.halfWidth];
  for (let i = 0; i < edges.length; i += 2) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    const segmentWidth = to - from;
    if (segmentWidth <= 0.01) continue;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(segmentWidth, GREYBOX.space.wallHeight, g.thickness),
      wallMaterial,
    );
    mesh.position.set(from + segmentWidth / 2, GREYBOX.space.wallHeight / 2, z);
    scene.add(mesh);
    partitionMeshes.push(mesh);
    partitions.push({
      minX: from,
      maxX: to,
      minZ: z - g.thickness / 2,
      maxZ: z + g.thickness / 2,
    });
  }

  for (const opening of openings) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(g.doorWidth, g.doorHeight, g.thickness), materials.gateClosed);
    door.position.set(opening.x, g.doorHeight / 2, z);
    scene.add(door);

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512;
    labelCanvas.height = 256;
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true }));
    label.scale.set(2.6, 1.3, 1);
    label.position.set(opening.x, g.labelHeight, z);
    scene.add(label);

    gates.push({
      roomId: opening.spec.roomId,
      label_ja: opening.spec.label_ja,
      required: opening.spec.required,
      door,
      label,
      labelCanvas,
      labelTexture,
      bounds: {
        minX: opening.x - g.doorWidth / 2,
        maxX: opening.x + g.doorWidth / 2,
        minZ: z - g.thickness / 2,
        maxZ: z + g.thickness / 2,
      },
      open: false,
    });
  }

  return { gates, partitions, partitionMeshes };
}

/** 門の開閉を反映する。開いた門は当たり判定も外れる。 */
export function setGateOpen(
  gate: GateObject,
  open: boolean,
  standing: number,
  materials: MaterialSet,
  colors: LabelColors,
): void {
  gate.open = open;
  gate.door.visible = !open;
  gate.door.material = open ? materials.gateOpen : materials.gateClosed;
  drawGateLabel(gate, standing, colors);
}

export function drawGateLabel(gate: GateObject, standing: number, colors: LabelColors): void {
  const ctx = gate.labelCanvas.getContext('2d');
  if (!ctx) throw new Error('2d コンテキストを取得できない');
  const { width, height } = gate.labelCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = gate.open ? colors.borderOpen : colors.borderClosed;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, width - 6, height - 6);
  ctx.textAlign = 'center';
  ctx.fillStyle = colors.title;
  fitFont(ctx, gate.label_ja, width - 48, 58, 'system-ui, sans-serif', 600);
  ctx.fillText(gate.label_ja, width / 2, 88);
  ctx.font = '44px ui-monospace, monospace';
  ctx.fillStyle = gate.open ? colors.open : colors.closed;
  ctx.fillText(gate.open ? '開' : '閉', width / 2, 150);
  ctx.font = '36px ui-monospace, monospace';
  ctx.fillStyle = colors.body;
  ctx.fillText(`standing ${standing} / ${gate.required}`, width / 2, 206);
  gate.labelTexture.needsUpdate = true;
}

function colorOf(config: PresentationConfig, key: string): THREE.Color {
  return new THREE.Color(cssColor(config, key));
}

function buildStall(slot: StallSlot, materials: MaterialSet, colors: LabelColors): StallObject {
  const { width, depth, height, counterHeight, counterOverhang, labelHeight } = GREYBOX.stall;
  const group = new THREE.Group();
  group.position.set(slot.x, 0, slot.z);
  group.rotation.y = slot.rotationY;

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    slot.direction === 'import' ? materials.stallImport : materials.stallExport,
  ) as THREE.Mesh<THREE.BoxGeometry, THREE.Material>;
  body.position.y = height / 2;
  group.add(body);

  // 通路側のカウンター。stall の前に立てることを形で示すだけの箱。
  const counter = new THREE.Mesh(new THREE.BoxGeometry(width, 0.16, counterOverhang), materials.counter);
  counter.position.set(0, counterHeight, depth / 2 + counterOverhang / 2);
  group.add(counter);

  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 512;
  labelCanvas.height = 256;
  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true }));
  label.scale.set(GREYBOX.stall.labelScale.x, GREYBOX.stall.labelScale.y, 1);
  label.position.set(slot.x, labelHeight, slot.z);

  // ワールド座標の当たり判定。回転は 90 度単位なので幅と奥行きを入れ替えるだけで足りる。
  const rotated = Math.abs(Math.sin(slot.rotationY)) > 0.5;
  const halfX = (rotated ? depth : width) / 2;
  const halfZ = (rotated ? width : depth) / 2;

  return {
    slot,
    group,
    body,
    counter,
    label,
    labelCanvas,
    labelTexture,
    bounds: {
      minX: slot.x - halfX,
      maxX: slot.x + halfX,
      minZ: slot.z - halfZ,
      maxZ: slot.z + halfZ,
    },
  };
}

/** 看板の描き直し。市場の値はサーバ由来のものをそのまま載せる。 */
export function drawStallLabel(
  stall: StallObject,
  lines: { title: string; price: string; stock: string; shock: boolean },
  colors: LabelColors,
): void {
  const ctx = stall.labelCanvas.getContext('2d');
  if (!ctx) throw new Error('2d コンテキストを取得できない');
  const { width, height } = stall.labelCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = lines.shock ? colors.borderShock : colors.border;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, width - 6, height - 6);

  ctx.textAlign = 'center';
  ctx.fillStyle = colors.title;
  // 長いカテゴリ名でも切れないよう、幅に収まるまで縮める（config 由来なので長さは可変）。
  fitFont(ctx, lines.title, width - 48, 62, 'system-ui, sans-serif', 600);
  ctx.fillText(lines.title, width / 2, 92);
  ctx.font = '48px ui-monospace, monospace';
  ctx.fillStyle = colors.body;
  ctx.fillText(lines.price, width / 2, 160);
  ctx.fillText(lines.stock, width / 2, 214);
  stall.labelTexture.needsUpdate = true;
}

function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  family: string,
  weight = 400,
): void {
  let size = startSize;
  for (; size > 18; size -= 2) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) return;
  }
  ctx.font = `${weight} ${size}px ${family}`;
}
