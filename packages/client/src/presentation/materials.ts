import * as THREE from 'three';
import type { MaterialSlotId, PresentationConfig, RenderMode } from '@na/shared';
import { color, param } from './config.js';
import { STYLIZED_SURFACE_FRAGMENT, STYLIZED_SURFACE_VERTEX } from './shaders/stylized-surface.js';

/**
 * マテリアルの差し込み口。
 * 差し替え単位は要素種別（floor / wall / stall / counter / gate）。個別のオブジェクトを名指ししない。
 * 色は base / shadow の対で config から引く。greybox は base のみ、stylized は対を使う。
 */

export interface MaterialSet {
  mode: RenderMode;
  floor: THREE.Material;
  wall: THREE.Material;
  /** stall の木枠。輸入／輸出で色は変えない（差は日除け布で出す）。 */
  stallWood: THREE.Material;
  /** 日除け布。暖色＝輸入側、寒色＝輸出側。 */
  clothWarm: THREE.Material;
  clothCool: THREE.Material;
  stallHighlight: THREE.Material;
  counter: THREE.Material;
  gateClosed: THREE.Material;
  gateOpen: THREE.Material;
  dispose(): void;
}

/** stall 本体は木枠。focus のときだけ差し替える。 */
export function stallMaterial(set: MaterialSet, _direction: string, focused: boolean): THREE.Material {
  return focused ? set.stallHighlight : set.stallWood;
}

/** 日除け布は向きで色が変わる。 */
export function clothMaterial(set: MaterialSet, direction: string): THREE.Material {
  return direction === 'import' ? set.clothWarm : set.clothCool;
}

/** 低い斜光の向き。仰角・方位角は config から。 */
export function keyLightDirection(config: PresentationConfig): THREE.Vector3 {
  const elevation = (config.lighting.keyElevationDeg * Math.PI) / 180;
  const azimuth = (config.lighting.keyAzimuthDeg * Math.PI) / 180;
  return new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  ).normalize();
}

export function createMaterialSet(config: PresentationConfig, mode: RenderMode): MaterialSet {
  const made: THREE.Material[] = [];
  const lightDir = keyLightDirection(config);

  const build = (slot: MaterialSlotId, baseKey: string, shadowKey: string): THREE.Material => {
    const material =
      mode === 'greybox'
        ? new THREE.MeshLambertMaterial({ color: color(config, baseKey) })
        : stylizedMaterial(config, slot, baseKey, shadowKey, lightDir);
    made.push(material);
    return material;
  };

  return {
    mode,
    floor: build('floor', 'floorBase', 'floorShadow'),
    wall: build('wall', 'wallBase', 'wallShadow'),
    stallWood: build('stall', 'stallWood', 'stallWoodShadow'),
    clothWarm: build('stall', 'stallClothWarm', 'stallClothWarmShadow'),
    clothCool: build('stall', 'stallClothCool', 'stallClothCoolShadow'),
    stallHighlight: build('stall', 'highlight', 'highlightShadow'),
    counter: build('counter', 'counterWood', 'counterWoodShadow'),
    gateClosed: build('gate', 'gateStone', 'gateStoneShadow'),
    gateOpen: build('gate', 'gateOpenMarker', 'gateOpenMarkerShadow'),
    dispose: () => {
      for (const material of made) material.dispose();
    },
  };
}

function stylizedMaterial(
  config: PresentationConfig,
  slot: MaterialSlotId,
  baseKey: string,
  shadowKey: string,
  lightDir: THREE.Vector3,
): THREE.Material {
  const definition = config.materials.slots[slot];
  const where = `materials.slots.${slot}.params`;
  return new THREE.ShaderMaterial({
    vertexShader: STYLIZED_SURFACE_VERTEX,
    fragmentShader: STYLIZED_SURFACE_FRAGMENT,
    uniforms: {
      uColor: { value: color(config, baseKey) },
      uShadowColor: { value: color(config, shadowKey) },
      uTintColor: { value: color(config, config.lighting.keyColorKey) },
      uLightDir: { value: lightDir.clone() },
      // 環境光の効き。greybox（Lambert）の露出とおおよそ揃うところに置く。
      uAmbient: { value: clamp01(config.lighting.ambientIntensity * AMBIENT_FLOOR) },
      uBands: { value: param(definition.params, 'bands', where) },
      uRim: { value: param(definition.params, 'rim', where) },
      uWarp: { value: param(definition.params, 'warp', where) },
      uTint: { value: param(definition.params, 'tint', where) },
    },
  });
}

/**
 * stylized の暗部の底。config の ambientIntensity にこの係数を掛けた値が、
 * shadow 色から base 色へどれだけ寄るかの下限になる。低キーを保つために小さめ。
 */
const AMBIENT_FLOOR = 0.25;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
