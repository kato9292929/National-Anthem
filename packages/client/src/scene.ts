import * as THREE from 'three';
import { GREYBOX } from './greybox.js';
import type { MarketLayout, StallSlot } from './layout.js';

/**
 * グレイボックスの市場空間。無地の床・壁・箱だけ。
 * テクスチャもモデルも読み込まない（presentation は範囲外）。
 */

export interface StallObject {
  slot: StallSlot;
  group: THREE.Group;
  body: THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial>;
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
  door: THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial>;
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
}

/** 門が要る room（standing のしきい値がある room）だけを門にする。 */
export interface GateSpec {
  roomId: string;
  label_ja: string;
  required: number;
}

export function buildScene(layout: MarketLayout, gateSpecs: GateSpec[] = []): BuiltScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(GREYBOX.color.sky);
  scene.fog = new THREE.Fog(GREYBOX.color.fog, GREYBOX.fog.near, GREYBOX.fog.far);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(6, 14, 8);
  scene.add(key);

  const width = layout.halfWidth * 2;
  const depth = layout.halfDepth * 2;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshLambertMaterial({ color: GREYBOX.color.floor }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const wallMaterial = new THREE.MeshLambertMaterial({ color: GREYBOX.color.wall });
  const { wallHeight: h, wallThickness: t } = GREYBOX.space;
  const walls: [number, number, number, number, number][] = [
    [width + t, h, t, 0, -layout.halfDepth],
    [width + t, h, t, 0, layout.halfDepth],
    [t, h, depth + t, -layout.halfWidth, 0],
    [t, h, depth + t, layout.halfWidth, 0],
  ];
  for (const [w, hh, d, x, z] of walls) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), wallMaterial);
    wall.position.set(x, hh / 2, z);
    scene.add(wall);
  }

  const stalls = layout.slots.map((slot) => buildStall(slot));
  for (const stall of stalls) {
    scene.add(stall.group);
    // 看板はワールド座標に置く（group は回転しているので入れ子にしない）。
    scene.add(stall.label);
  }

  const { gates, partitions } = buildPartition(scene, layout, gateSpecs, wallMaterial);

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
  wallMaterial: THREE.MeshLambertMaterial,
): { gates: GateObject[]; partitions: { minX: number; maxX: number; minZ: number; maxZ: number }[] } {
  const gates: GateObject[] = [];
  const partitions: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  if (specs.length === 0) return { gates, partitions };

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
    partitions.push({
      minX: from,
      maxX: to,
      minZ: z - g.thickness / 2,
      maxZ: z + g.thickness / 2,
    });
  }

  for (const opening of openings) {
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(g.doorWidth, g.doorHeight, g.thickness),
      new THREE.MeshLambertMaterial({ color: g.colorClosed }),
    );
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

  return { gates, partitions };
}

/** 門の開閉を反映する。開いた門は当たり判定も外れる。 */
export function setGateOpen(gate: GateObject, open: boolean, standing: number): void {
  gate.open = open;
  gate.door.visible = !open;
  gate.door.material.color.setHex(open ? GREYBOX.gate.colorOpenMarker : GREYBOX.gate.colorClosed);
  drawGateLabel(gate, standing);
}

export function drawGateLabel(gate: GateObject, standing: number): void {
  const ctx = gate.labelCanvas.getContext('2d');
  if (!ctx) throw new Error('2d コンテキストを取得できない');
  const { width, height } = gate.labelCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(20,21,23,0.86)';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = gate.open ? '#9fd39f' : '#a38f5c';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, width - 6, height - 6);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e6e7e9';
  fitFont(ctx, gate.label_ja, width - 48, 58, 'system-ui, sans-serif', 600);
  ctx.fillText(gate.label_ja, width / 2, 88);
  ctx.font = '44px ui-monospace, monospace';
  ctx.fillStyle = gate.open ? '#9fd39f' : '#d9c48a';
  ctx.fillText(gate.open ? '開' : '閉', width / 2, 150);
  ctx.font = '36px ui-monospace, monospace';
  ctx.fillStyle = '#b9bcc0';
  ctx.fillText(`standing ${standing} / ${gate.required}`, width / 2, 206);
  gate.labelTexture.needsUpdate = true;
}

function buildStall(slot: StallSlot): StallObject {
  const { width, depth, height, counterHeight, counterOverhang, labelHeight } = GREYBOX.stall;
  const group = new THREE.Group();
  group.position.set(slot.x, 0, slot.z);
  group.rotation.y = slot.rotationY;

  const bodyColor = slot.direction === 'import' ? GREYBOX.color.stallImport : GREYBOX.color.stallExport;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshLambertMaterial({ color: bodyColor }),
  );
  body.position.y = height / 2;
  group.add(body);

  // 通路側のカウンター。stall の前に立てることを形で示すだけの箱。
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.16, counterOverhang),
    new THREE.MeshLambertMaterial({ color: GREYBOX.color.counter }),
  );
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
): void {
  const ctx = stall.labelCanvas.getContext('2d');
  if (!ctx) throw new Error('2d コンテキストを取得できない');
  const { width, height } = stall.labelCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(20,21,23,0.86)';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = lines.shock ? '#d9c48a' : '#6a6d72';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, width - 6, height - 6);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#e6e7e9';
  // 長いカテゴリ名でも切れないよう、幅に収まるまで縮める（config 由来なので長さは可変）。
  fitFont(ctx, lines.title, width - 48, 62, 'system-ui, sans-serif', 600);
  ctx.fillText(lines.title, width / 2, 92);
  ctx.font = '48px ui-monospace, monospace';
  ctx.fillStyle = '#b9bcc0';
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
