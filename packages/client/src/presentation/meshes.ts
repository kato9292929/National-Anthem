import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assignedMeshSlots, type MaterialSlotId, type MeshAssetSlot, type PresentationConfig } from '@na/shared';

/**
 * 生成メッシュのインポートと最適化。
 * - .glb を three へ読み込む
 * - greybox の箱に合わせて長辺を正規化し、up 補正を掛ける
 * - web/モバイルのポリゴン予算を超えていれば decimation で落とす（超過は隠さない）
 * - 質感は stylize-on-top: マテリアルは presentation の stylized シェーダに差し替える
 *
 * 実物のトポロジーが無い placeholder も同じ経路で扱う。placeholder であることは失わない。
 */

/** web/モバイルのポリゴン予算（tri）。生成物はデフォルト 2万〜30万なので超えたら落とす。 */
export const MESH_TRIANGLE_BUDGET = 40000;

export interface LoadedMesh {
  slot: MaterialSlotId;
  asset: MeshAssetSlot;
  object: THREE.Object3D;
  triangles: number;
  /** 予算超過で decimation した後の三角数（していなければ triangles と同じ）。 */
  reducedTriangles: number;
  placeholder: boolean;
}

export interface MeshLoadReport {
  loaded: LoadedMesh[];
  failures: { slot: MaterialSlotId; url: string; error: string }[];
}

function countTriangles(object: THREE.Object3D): number {
  let tris = 0;
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const geometry = mesh.geometry;
      tris += (geometry.index ? geometry.index.count : geometry.attributes['position']!.count) / 3;
    }
  });
  return Math.round(tris);
}

/** 長辺を fitLongestEdge に合わせ、原点を底面中心に置く。up 補正も掛ける。 */
function fitAndOrient(object: THREE.Object3D, asset: MeshAssetSlot): void {
  object.rotation.set(
    (asset.rotationDeg.x * Math.PI) / 180,
    (asset.rotationDeg.y * Math.PI) / 180,
    (asset.rotationDeg.z * Math.PI) / 180,
  );
  object.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (asset.fitLongestEdge > 0 && longest > 0) {
    const scale = asset.fitLongestEdge / longest;
    object.scale.multiplyScalar(scale);
    object.updateMatrixWorld(true);
  }

  const fitted = new THREE.Box3().setFromObject(object);
  const center = fitted.getCenter(new THREE.Vector3());
  // XZ を中心へ、Y を底面が 0 に来るように。
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= fitted.min.y;
}

/**
 * 予算を超えていれば、頂点を間引いて三角数を落とす。
 * 完全な decimation ではなく「予算に収める」ことが目的の簡易版。
 * three の同梱 SimplifyModifier を使い、無ければそのまま返す（黙って壊さない）。
 */
async function decimateToBudget(object: THREE.Object3D, budget: number): Promise<void> {
  const current = countTriangles(object);
  if (current <= budget) return;
  const { SimplifyModifier } = await import('three/examples/jsm/modifiers/SimplifyModifier.js');
  const modifier = new SimplifyModifier();
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry;
    const tris = (geometry.index ? geometry.index.count : geometry.attributes['position']!.count) / 3;
    const share = tris / current;
    const targetTris = Math.max(4, Math.floor(budget * share));
    const removeCount = Math.max(0, Math.floor((geometry.attributes['position']!.count) * (1 - targetTris / tris)));
    if (removeCount > 0) mesh.geometry = modifier.modify(geometry, removeCount);
  });
}

/** マテリアルを presentation の見た目に差し替える（stylize-on-top）。 */
function applyMaterial(object: THREE.Object3D, material: THREE.Material): void {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) mesh.material = material;
  });
}

/**
 * 割り当てられたメッシュを読む。
 * 1 つ落ちても全体を止めない（失敗は report に集め、greybox 形状にフォールバックする）。
 * ただし「読めたことにして空を返す」ことはしない。失敗は失敗として残す。
 */
export async function loadAssignedMeshes(
  config: PresentationConfig,
  materialFor: (slot: MaterialSlotId) => THREE.Material,
): Promise<MeshLoadReport> {
  const loader = new GLTFLoader();
  const report: MeshLoadReport = { loaded: [], failures: [] };

  for (const { slot, asset } of assignedMeshSlots(config)) {
    try {
      const gltf = await loader.loadAsync(asset.url);
      const object = gltf.scene;
      const triangles = countTriangles(object);
      fitAndOrient(object, asset);
      await decimateToBudget(object, MESH_TRIANGLE_BUDGET);
      const reducedTriangles = countTriangles(object);
      applyMaterial(object, materialFor(slot));
      report.loaded.push({ slot, asset, object, triangles, reducedTriangles, placeholder: asset.placeholder });
    } catch (error) {
      report.failures.push({ slot, url: asset.url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
