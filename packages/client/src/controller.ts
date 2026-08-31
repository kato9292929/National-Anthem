import * as THREE from 'three';
import { GREYBOX } from './greybox.js';
import type { Collider, StallObject } from './scene.js';

/**
 * 一人称コントローラ。ポインタロック＋WASD。
 * 当たり判定は XZ 平面の矩形のみ（グレイボックス段階に必要な最小限）。
 */

export interface ControllerOptions {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  stalls: StallObject[];
  /** 当たり判定の対象。門は開いている間だけ通れる。 */
  colliders: Collider[];
  bounds: { halfWidth: number; halfDepth: number };
  onLockChange?: (locked: boolean) => void;
}

export class FirstPersonController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly stalls: StallObject[];
  private readonly colliders: Collider[];
  private readonly bounds: { halfWidth: number; halfDepth: number };
  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector3();
  private readonly position = new THREE.Vector3(0, GREYBOX.player.eyeHeight, 0);
  private yaw = 0;
  private pitch = 0;
  private locked = false;

  constructor(private readonly options: ControllerOptions) {
    this.camera = options.camera;
    this.canvas = options.canvas;
    this.stalls = options.stalls;
    this.colliders = options.colliders;
    this.bounds = options.bounds;

    this.canvas.addEventListener('click', () => {
      void this.canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.options.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', (event) => {
      if (!this.locked) return;
      this.yaw -= event.movementX * GREYBOX.player.lookSensitivity;
      this.pitch -= event.movementY * GREYBOX.player.lookSensitivity;
      const limit = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    });
    window.addEventListener('keydown', (event) => this.keys.add(event.code));
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.keys.clear());

    this.camera.rotation.order = 'YXZ';
    this.apply();
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get playerPosition(): THREE.Vector3 {
    return this.position.clone();
  }

  /** 自動確認から任意の位置に置く。当たり判定は次の update から効く。 */
  teleport(x: number, z: number): void {
    this.position.set(x, GREYBOX.player.eyeHeight, z);
    this.velocity.set(0, 0, 0);
    this.apply();
  }

  /** テストと自動確認から動かすための入口（ポインタロック無しでも歩ける）。 */
  setInput(codes: string[]): void {
    this.keys.clear();
    for (const code of codes) this.keys.add(code);
  }

  update(dt: number): void {
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
      ? GREYBOX.player.sprintSpeed
      : GREYBOX.player.walkSpeed;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // yaw 0 のとき -Z が前。
    const wish = new THREE.Vector3(
      -forward * sin + strafe * cos,
      0,
      -forward * cos - strafe * sin,
    );
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);

    const damping = Math.min(1, GREYBOX.player.damping * dt);
    this.velocity.lerp(wish, damping);

    // 軸ごとに動かして解決する。壁に沿って滑れる。
    this.moveAxis('x', this.velocity.x * dt);
    this.moveAxis('z', this.velocity.z * dt);
    this.apply();
  }

  /** いま正面に立っている stall。無ければ null。 */
  focusedStall(): StallObject | null {
    const range = GREYBOX.player.stallFocusRange;
    let best: StallObject | null = null;
    let bestDistance: number = range;
    for (const stall of this.stalls) {
      const dx = stall.slot.x - this.position.x;
      const dz = stall.slot.z - this.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = stall;
      }
    }
    return best;
  }

  private moveAxis(axis: 'x' | 'z', delta: number): void {
    if (delta === 0) return;
    const next = this.position.clone();
    next[axis] += delta;

    const r = GREYBOX.player.radius;
    const limitX = this.bounds.halfWidth - GREYBOX.space.wallThickness - r;
    const limitZ = this.bounds.halfDepth - GREYBOX.space.wallThickness - r;
    next.x = Math.max(-limitX, Math.min(limitX, next.x));
    next.z = Math.max(-limitZ, Math.min(limitZ, next.z));

    for (const collider of this.colliders) {
      if (!collider.isSolid()) continue;
      const b = collider.bounds;
      if (
        next.x > b.minX - r &&
        next.x < b.maxX + r &&
        next.z > b.minZ - r &&
        next.z < b.maxZ + r
      ) {
        this.velocity[axis] = 0;
        return;
      }
    }
    this.position.copy(next);
  }

  private apply(): void {
    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }
}
