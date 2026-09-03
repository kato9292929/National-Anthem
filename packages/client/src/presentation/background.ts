import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PackedSplats, setPackedSplat, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { BackgroundLayerConfig } from '@na/shared';
import type { Collider } from '../scene.js';

/**
 * 背景レイヤー（Marble / Atlas の Gaussian splat）。
 * 見た目専用。前景（scene graph・当たり判定・対話）とは融合しない。
 *
 * - Spark の SparkRenderer をシーンに add し、SplatMesh を前景の奥に置く。
 *   Spark は通常の render(scene, camera) の中で三角形メッシュと深度合成するので、
 *   手前の stall・什器が奥の splat を隠す（＝背景は常に前景の奥）。
 * - 当たり判定は splat には付けない。歩ける床/壁が要るなら Collider Builder の
 *   .glb を「見えない衝突メッシュ」として別に読む（splat と collider を混同しない）。
 *
 * 【未検証】前景メッシュ＋x402＋背景 splat の重ねは組んだばかり。
 * 複雑な相互遮蔽の破綻と実機 fps は実機計測待ち。
 *
 * placeholder（ダミー splat）は実物に見せない。procedural な点群を出すだけ。
 */

/** procedural placeholder の合図。実 splat の url ではない。 */
export const PLACEHOLDER_SPLAT_URL = 'placeholder:procedural';

export interface BackgroundStatus {
  enabled: boolean;
  loaded: boolean;
  placeholder: boolean;
  splatUrl: string;
  colliderUrl: string;
  colliderBoxes: number;
  applyPostprocessRequested: boolean;
  /** 単一シーン合成のため per-layer 除外は未実装。 */
  perLayerPostprocess: 'single-scene（前景と同じ扱い・per-layer 除外は未実装）';
  error: string | null;
}

export interface BackgroundLayerOptions {
  config: BackgroundLayerConfig;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  onError: (message: string) => void;
}

export class BackgroundLayer {
  private spark: SparkRenderer | null = null;
  private splat: SplatMesh | null = null;
  private colliderRoot: THREE.Group | null = null;
  private colliderBoxes: Collider[] = [];
  private enabled: boolean;
  private loaded = false;
  private error: string | null = null;

  constructor(private readonly options: BackgroundLayerOptions) {
    this.enabled = options.config.enabled && options.config.splatUrl !== '';
  }

  get isEnabled(): boolean {
    return this.enabled && this.loaded;
  }

  /** 背景 splat と collider を読む。失敗しても前景は動かす（フォールバックを成功に見せない）。 */
  async load(): Promise<void> {
    if (!this.options.config.enabled || this.options.config.splatUrl === '') return;
    try {
      // SparkRenderer は 1 つだけシーンに置く。
      this.spark = new SparkRenderer({ renderer: this.options.renderer });
      this.options.scene.add(this.spark);

      this.splat = this.options.config.splatUrl === PLACEHOLDER_SPLAT_URL
        ? this.buildPlaceholderSplat()
        : new SplatMesh({ url: this.options.config.splatUrl });

      const c = this.options.config;
      this.splat.position.set(c.position.x, c.position.y, c.position.z);
      this.splat.rotation.set(
        (c.rotationDeg.x * Math.PI) / 180,
        (c.rotationDeg.y * Math.PI) / 180,
        (c.rotationDeg.z * Math.PI) / 180,
      );
      this.splat.scale.setScalar(c.scale);
      this.splat.visible = this.enabled;
      this.options.scene.add(this.splat);

      if (c.colliderUrl !== '') await this.loadCollider(c.colliderUrl);
      this.loaded = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.options.onError(`背景 splat を読めない: ${this.error}`);
      // 読めなければ背景は無いものとして前景だけで動く。成功に見せない。
      this.enabled = false;
      this.loaded = false;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on && this.loaded;
    if (this.splat) this.splat.visible = this.enabled;
  }

  /** 背景 collider（見えない衝突メッシュ）の当たり。前景の controller に足す。 */
  colliders(): Collider[] {
    return this.enabled ? this.colliderBoxes : [];
  }

  status(): BackgroundStatus {
    return {
      enabled: this.enabled,
      loaded: this.loaded,
      placeholder: this.options.config.placeholder,
      splatUrl: this.options.config.splatUrl,
      colliderUrl: this.options.config.colliderUrl,
      colliderBoxes: this.colliderBoxes.length,
      applyPostprocessRequested: this.options.config.applyPostprocess,
      perLayerPostprocess: 'single-scene（前景と同じ扱い・per-layer 除外は未実装）',
      error: this.error,
    };
  }

  dispose(): void {
    if (this.splat) this.options.scene.remove(this.splat);
    if (this.spark) this.options.scene.remove(this.spark);
    if (this.colliderRoot) this.options.scene.remove(this.colliderRoot);
  }

  private async loadCollider(url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    const root = gltf.scene;
    root.visible = false; // 衝突用。描かない。
    this.options.scene.add(root);
    this.colliderRoot = root;
    // 各メッシュの AABB を controller の矩形当たりに落とす。
    root.updateMatrixWorld(true);
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const box = new THREE.Box3().setFromObject(mesh);
      const bounds = { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };
      this.colliderBoxes.push({ bounds, isSolid: () => true });
    });
  }

  /** ダミーの点群。実 splat の代わりではないことが分かるよう、粗い雲にする。 */
  private buildPlaceholderSplat(): SplatMesh {
    const packed = new PackedSplats();
    const count = 1500;
    let seed = 1234;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < count; i++) {
      // 遠景の壁のような、横に広い薄い雲。
      const x = (rand() - 0.5) * 80;
      const y = rand() * 25;
      const z = (rand() - 0.5) * 20;
      const s = 0.3 + rand() * 0.5;
      // 暖色の土っぽい色（前景 Donwood と大喧嘩しない当たり）。
      // setPackedSplat の型は Uint32Array を要求するが、実体は PackedSplats を受ける。
      // setPackedSplat の型は Uint32Array を要求するが、実体は PackedSplats を受ける。
      setPackedSplat(packed as unknown as Uint32Array, i, x, y, z, s, s, s, 0, 0, 0, 1, 0.9, 200, 150 + rand() * 40, 120 + rand() * 30);
    }
    return new SplatMesh({ packedSplats: packed });
  }
}
