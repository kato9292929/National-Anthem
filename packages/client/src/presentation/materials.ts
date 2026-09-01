import * as THREE from 'three';
import type { MaterialSlotId, PresentationConfig, RenderMode } from '@na/shared';
import { color, param } from './config.js';
import { STYLIZED_SURFACE_FRAGMENT, STYLIZED_SURFACE_VERTEX } from './shaders/stylized-surface.js';

/**
 * マテリアルの差し込み口。
 * 差し替え単位は要素種別（floor / wall / stall / counter / gate）。個別のオブジェクトを名指ししない。
 * greybox と stylized は同じスロット構成で、モードだけを切り替える。
 */

export interface MaterialSet {
  mode: RenderMode;
  floor: THREE.Material;
  wall: THREE.Material;
  stallImport: THREE.Material;
  stallExport: THREE.Material;
  stallHighlight: THREE.Material;
  counter: THREE.Material;
  gateClosed: THREE.Material;
  gateOpen: THREE.Material;
  dispose(): void;
}

/** stall の向きと focus 状態から使うマテリアルを決める。scene 側に色を持たせない。 */
export function stallMaterial(set: MaterialSet, direction: string, focused: boolean): THREE.Material {
  if (focused) return set.stallHighlight;
  return direction === 'import' ? set.stallImport : set.stallExport;
}

export function createMaterialSet(config: PresentationConfig, mode: RenderMode): MaterialSet {
  const made: THREE.Material[] = [];

  const build = (slot: MaterialSlotId, colorKey: string): THREE.Material => {
    const material =
      mode === 'greybox'
        ? new THREE.MeshLambertMaterial({ color: color(config, colorKey) })
        : stylizedMaterial(config, slot, colorKey);
    made.push(material);
    return material;
  };

  return {
    mode,
    floor: build('floor', 'floor'),
    wall: build('wall', 'wall'),
    stallImport: build('stall', 'stallImport'),
    stallExport: build('stall', 'stallExport'),
    stallHighlight: build('stall', 'highlight'),
    counter: build('counter', 'counter'),
    gateClosed: build('gate', 'gateClosed'),
    gateOpen: build('gate', 'gateOpen'),
    dispose: () => {
      for (const material of made) material.dispose();
    },
  };
}

function stylizedMaterial(config: PresentationConfig, slot: MaterialSlotId, colorKey: string): THREE.Material {
  const definition = config.materials.slots[slot];
  const where = `materials.slots.${slot}.params`;
  return new THREE.ShaderMaterial({
    vertexShader: STYLIZED_SURFACE_VERTEX,
    fragmentShader: STYLIZED_SURFACE_FRAGMENT,
    uniforms: {
      uColor: { value: color(config, colorKey) },
      uTintColor: { value: color(config, 'highlight') },
      // 光の向きは lighting の設定から作る。ここで固定値を持たない。
      uLightDir: { value: new THREE.Vector3(0.4, 1, 0.55).normalize() },
      uAmbient: { value: clamp01(config.lighting.ambientIntensity / 2) },
      uBands: { value: param(definition.params, 'bands', where) },
      uRim: { value: param(definition.params, 'rim', where) },
      uWarp: { value: param(definition.params, 'warp', where) },
      uTint: { value: param(definition.params, 'tint', where) },
    },
  });
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
