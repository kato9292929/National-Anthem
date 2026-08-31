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

export interface BuiltScene {
  scene: THREE.Scene;
  stalls: StallObject[];
  bounds: { halfWidth: number; halfDepth: number };
}

export function buildScene(layout: MarketLayout): BuiltScene {
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

  return { scene, stalls, bounds: { halfWidth: layout.halfWidth, halfDepth: layout.halfDepth } };
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
