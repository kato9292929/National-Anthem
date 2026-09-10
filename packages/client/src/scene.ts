import * as THREE from 'three';
import type { PresentationConfig } from '@na/shared';
import { GREYBOX } from './greybox.js';
import type { MarketLayout, StallSlot } from './layout.js';
import { cssColor } from './presentation/config.js';
import { clothMaterial, keyLightDirection, stallMaterial, type MaterialSet } from './presentation/materials.js';
import type { LoadedMesh } from './presentation/meshes.js';
import type { MaterialSlotId } from '@na/shared';

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
  /** 日除け布。 */
  awning: THREE.Mesh<THREE.BoxGeometry, THREE.Material>;
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
  /**
   * 生成メッシュに差し替える（use=true）／greybox の箱に戻す（use=false）。
   * 割り当ての無い要素種別は箱のまま。greybox 経路は消さない。
   */
  applyMeshes(meshes: Map<MaterialSlotId, LoadedMesh>, use: boolean): void;
  /**
   * greybox の構造（床・壁・stall の箱・門）をまとめて表示/非表示する。
   * 環境メッシュ（ur.glb）を丸ごと乗せるときに構造だけ隠す。看板（価格札）は残す。
   */
  setStructureVisible(visible: boolean): void;
}

/** greybox の箱と、そこへ差し込む生成メッシュの置き場。 */
interface MeshAnchor {
  slot: MaterialSlotId;
  /** greybox 側のメッシュ（複数持つ要素もある）。 */
  boxes: THREE.Object3D[];
  /** 箱の中心・寸法・向き（生成メッシュを合わせる基準）。 */
  position: THREE.Vector3;
  rotationY: number;
  /** 箱の footprint（生成メッシュの長辺をこれに合わせる）。 */
  footprint: number;
  /** 差し込んだ生成メッシュ（インスタンス）。 */
  instance: THREE.Object3D | null;
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
      colorOf(presentation, presentation.lighting.ambientColorKey),
      colorOf(presentation, 'floorShadow'),
      presentation.lighting.ambientIntensity,
    ),
  );
  // 低い斜光。向きは config の仰角・方位角から作る。
  const key = new THREE.DirectionalLight(
    colorOf(presentation, presentation.lighting.keyColorKey),
    presentation.lighting.keyIntensity,
  );
  key.position.copy(keyLightDirection(presentation).multiplyScalar(40));
  scene.add(key);

  const width = layout.halfWidth * 2;
  const depth = layout.halfDepth * 2;

  // greybox の構造（床・壁・箱・門）はまとめて隠せるよう 1 つの group に入れる。
  // 看板（価格札）はここに入れず scene に直に置く（環境メッシュ時も残す）。
  const structure = new THREE.Group();
  scene.add(structure);

  const anchors: MeshAnchor[] = [];
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), materials.floor);
  const walls: THREE.Mesh[] = [];
  floor.rotation.x = -Math.PI / 2;
  structure.add(floor);

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
    structure.add(wall);
    walls.push(wall);
    anchors.push({
      slot: 'wall',
      boxes: [wall],
      position: wall.position.clone(),
      rotationY: 0,
      footprint: Math.max(w, hh, d),
      instance: null,
    });
  }

  const stalls = layout.slots.map((slot) => buildStall(slot, materials, colors));
  for (const stall of stalls) {
    anchors.push({
      slot: 'stall',
      boxes: [stall.body],
      position: new THREE.Vector3(stall.slot.x, 0, stall.slot.z),
      rotationY: stall.slot.rotationY,
      footprint: Math.max(GREYBOX.stall.width, GREYBOX.stall.height, GREYBOX.stall.depth),
      instance: null,
    });
  }
  for (const stall of stalls) {
    structure.add(stall.group);
    // 看板はワールド座標に置く（group は回転しているので入れ子にしない）。環境メッシュ時も残す。
    scene.add(stall.label);
  }

  const { gates, partitions, partitionMeshes } = buildPartition(structure, scene, layout, gateSpecs, wallMaterial, materials, colors);
  for (const gate of gates) {
    anchors.push({
      slot: 'gate',
      boxes: [gate.door],
      position: gate.door.position.clone(),
      rotationY: 0,
      footprint: Math.max(GREYBOX.gate.doorWidth, GREYBOX.gate.doorHeight),
      instance: null,
    });
  }
  anchors.push({
    slot: 'floor',
    boxes: [floor],
    position: new THREE.Vector3(0, 0, 0),
    rotationY: 0,
    footprint: Math.max(width, depth),
    instance: null,
  });

  // 生成メッシュ（per-slot）のインスタンスは構造 group に入れ、構造トグルと一緒に扱う。
  const meshLayer = new THREE.Group();
  structure.add(meshLayer);

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
    applyMeshes: (meshes, use) => {
      for (const anchor of anchors) {
        const loaded = meshes.get(anchor.slot);
        // 割り当てが無ければ箱のまま。
        if (!use || !loaded) {
          if (anchor.instance) {
            meshLayer.remove(anchor.instance);
            anchor.instance = null;
          }
          for (const box of anchor.boxes) box.visible = true;
          continue;
        }
        // 既に差し込み済みなら作り直さない。
        if (!anchor.instance) {
          const instance = loaded.object.clone(true);
          // footprint に合わせて追加スケール（loader 側で fitLongestEdge 済みだが要素ごとに微調整）。
          const box = new THREE.Box3().setFromObject(instance);
          const size = box.getSize(new THREE.Vector3());
          const longest = Math.max(size.x, size.y, size.z);
          if (longest > 0 && anchor.footprint > 0) instance.scale.multiplyScalar(anchor.footprint / longest);
          instance.position.copy(anchor.position);
          instance.rotation.y = anchor.rotationY;
          meshLayer.add(instance);
          anchor.instance = instance;
        }
        anchor.instance.visible = true;
        for (const box of anchor.boxes) box.visible = false;
      }
    },
    setStructureVisible: (visible) => {
      structure.visible = visible;
    },
    applyMaterials: (next, focusedStallId) => {
      floor.material = next.floor;
      for (const wall of [...walls, ...partitionMeshes]) wall.material = next.wall;
      for (const stall of stalls) {
        stall.body.material = stallMaterial(next, stall.slot.direction, stall.slot.categoryId === focusedStallId);
        stall.counter.material = next.counter;
        stall.awning.material = clothMaterial(next, stall.slot.direction);
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
  structure: THREE.Object3D,
  labelParent: THREE.Object3D,
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
    structure.add(mesh);
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
    structure.add(door);

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512;
    labelCanvas.height = 256;
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true }));
    label.scale.set(2.6, 1.3, 1);
    label.position.set(opening.x, g.labelHeight, z);
    labelParent.add(label);

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
    materials.stallWood,
  ) as THREE.Mesh<THREE.BoxGeometry, THREE.Material>;
  body.position.y = height / 2;
  group.add(body);

  // 通路側のカウンター。stall の前に立てることを形で示すだけの箱。
  const counter = new THREE.Mesh(new THREE.BoxGeometry(width, 0.16, counterOverhang), materials.counter);
  counter.position.set(0, counterHeight, depth / 2 + counterOverhang / 2);
  group.add(counter);

  // 日除け布。通路側へ傾けて張り出す薄い庇（頭上なので当たり判定は変えない）。
  const awning = new THREE.Mesh(
    new THREE.BoxGeometry(width, GREYBOX.stall.awningThickness, GREYBOX.stall.awningDepth),
    clothMaterial(materials, slot.direction),
  ) as THREE.Mesh<THREE.BoxGeometry, THREE.Material>;
  awning.position.set(0, GREYBOX.stall.awningHeight, depth / 2 + GREYBOX.stall.awningDepth / 2);
  awning.rotation.x = Math.atan2(GREYBOX.stall.awningDrop, GREYBOX.stall.awningDepth);
  group.add(awning);

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
    awning,
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
