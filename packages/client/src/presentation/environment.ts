import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { EnvironmentAsset } from '@na/shared';

/**
 * ワールド全体の環境メッシュ（Blender 出力の 1 シーン）を読み込むレイヤー。
 *
 * - greybox の床 footprint に合わせて丸ごと 1 個スケール・配置する（fit-to-world）。
 * - greybox とはトグルで切り替える。決済インタラクション（stall の当たり・E 購入）は
 *   greybox 側の位置に据え置き、環境メッシュは見た目だけを上に乗せる（当たりは付けない）。
 * - 読み込み失敗は画面に出し、greybox にフォールバックする（成功に見せない）。
 * - Blender 本来のマテリアルをそのまま出す（stylizeOnTop で上掛けも選べる）。ポスプロは
 *   シーン全体に掛かるので、環境メッシュも前景と同じ絵作りになる。
 */

export interface EnvironmentStatus {
  enabled: boolean;
  loaded: boolean;
  placeholder: boolean;
  url: string;
  source: string;
  triangles: number;
  fitToWorld: boolean;
  stylizeOnTop: boolean;
  error: string | null;
}

export interface EnvironmentLayerOptions {
  config: EnvironmentAsset;
  scene: THREE.Scene;
  /** greybox の床の半分の寸法。fit-to-world の基準。 */
  worldBounds: { halfWidth: number; halfDepth: number };
  /** stylizeOnTop=true のとき上掛けするマテリアル。 */
  material?: THREE.Material;
  onError: (message: string) => void;
}

/**
 * glb のマテリアルを unlit（MeshBasic）へ変換する。
 * 各マテリアルの色（emissive があればそれを優先）をそのまま基本色に写す。
 * 景色の照明が暗くても Blender の色が確実に出る。glow のような発光マテリアルは明るいまま残る。
 */
function toUnlit(root: THREE.Object3D): void {
  const cache = new Map<THREE.Material, THREE.MeshBasicMaterial>();
  const convert = (src: THREE.Material): THREE.MeshBasicMaterial => {
    const cached = cache.get(src);
    if (cached) return cached;
    const std = src as THREE.MeshStandardMaterial;
    // 色は glb 由来だけを写す。ソースに色リテラルは置かない（既定は three の白）。
    const color = new THREE.Color();
    // 発光マテリアル（glow など）は emissive を、それ以外は baseColor を写す。
    if (std.emissive && (std.emissive.r > 0 || std.emissive.g > 0 || std.emissive.b > 0)) {
      color.copy(std.emissive);
    } else if (std.color) {
      color.copy(std.color);
    }
    const basic = new THREE.MeshBasicMaterial({
      color,
      ...(std.map ? { map: std.map } : {}),
      vertexColors: std.vertexColors ?? false,
      transparent: src.transparent,
      opacity: src.opacity,
      side: src.side,
    });
    cache.set(src, basic);
    return basic;
  };
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => convert(m))
      : convert(mesh.material);
  });
}

function countTriangles(object: THREE.Object3D): number {
  let tris = 0;
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const g = mesh.geometry;
      tris += (g.index ? g.index.count : g.attributes['position']!.count) / 3;
    }
  });
  return Math.round(tris);
}

export class EnvironmentLayer {
  private root: THREE.Group | null = null;
  private enabled: boolean;
  private loaded = false;
  private error: string | null = null;
  private triangles = 0;

  constructor(private readonly options: EnvironmentLayerOptions) {
    // 割り当てがあれば既定で環境メッシュ側を出す（greybox は M で戻せる）。
    this.enabled = options.config.url !== '';
  }

  get isEnabled(): boolean {
    return this.enabled && this.loaded;
  }

  get triangleCount(): number {
    return this.triangles;
  }

  /** 環境メッシュを読む。失敗しても前景（greybox）は動かす。 */
  async load(): Promise<void> {
    const c = this.options.config;
    if (c.url === '') return;
    try {
      const gltf = await new GLTFLoader().loadAsync(c.url);
      const root = gltf.scene;
      this.triangles = countTriangles(root);
      this.fitToWorld(root);
      if (c.stylizeOnTop && this.options.material) {
        const material = this.options.material;
        root.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.isMesh) mesh.material = material;
        });
      } else if (c.unlit) {
        // 景色の光量を絞っているため、PBR のままだと沈む。unlit にして Blender の色をそのまま出す。
        toUnlit(root);
      }
      root.visible = this.enabled;
      this.options.scene.add(root);
      this.root = root;
      this.loaded = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.options.onError(`環境メッシュを読めない: ${this.error}`);
      // 読めなければ環境は無いものとして greybox だけで動く。成功に見せない。
      this.enabled = false;
      this.loaded = false;
    }
  }

  /** greybox の footprint に合わせて丸ごとスケール・配置する。 */
  private fitToWorld(root: THREE.Group): void {
    const c = this.options.config;
    root.rotation.set(
      (c.rotationDeg.x * Math.PI) / 180,
      (c.rotationDeg.y * Math.PI) / 180,
      (c.rotationDeg.z * Math.PI) / 180,
    );
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    if (c.fitToWorld && size.x > 0 && size.z > 0) {
      const targetW = this.options.worldBounds.halfWidth * 2 * c.fitMargin;
      const targetD = this.options.worldBounds.halfDepth * 2 * c.fitMargin;
      // XZ の footprint を内側に収める（縦横比は保つ）。
      const scale = Math.min(targetW / size.x, targetD / size.z);
      if (scale > 0) root.scale.multiplyScalar(scale);
    }
    if (c.scale > 0) root.scale.multiplyScalar(c.scale);
    root.updateMatrixWorld(true);

    // XZ を中心へ、Y を底面が 0 に来るように。その後 config の手動オフセット。
    const fitted = new THREE.Box3().setFromObject(root);
    const center = fitted.getCenter(new THREE.Vector3());
    root.position.x += -center.x + c.position.x;
    root.position.z += -center.z + c.position.z;
    root.position.y += -fitted.min.y + c.position.y;
  }

  setEnabled(on: boolean): void {
    this.enabled = on && this.loaded;
    if (this.root) this.root.visible = this.enabled;
  }

  status(): EnvironmentStatus {
    return {
      enabled: this.enabled,
      loaded: this.loaded,
      placeholder: this.options.config.placeholder,
      url: this.options.config.url,
      source: this.options.config.source,
      triangles: this.triangles,
      fitToWorld: this.options.config.fitToWorld,
      stylizeOnTop: this.options.config.stylizeOnTop,
      error: this.error,
    };
  }

  dispose(): void {
    if (this.root) this.options.scene.remove(this.root);
  }
}
