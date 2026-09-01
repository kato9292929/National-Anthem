import { arr, bool, num, obj, oneOf, str } from './guards.js';

/**
 * presentation 層のスキーマ。
 * 色・質感・パス構成はすべて外から差す。ソースにマジックナンバーを置かない。
 * 未確定は confirmed:false ＋ ニュートラル既定（0 = 効果なし）で動かす。
 */

export type RenderMode = 'greybox' | 'stylized';

/** ポスプロのパス種別。ここに無い id は受け付けない（推測で通さない）。 */
export const POST_PASS_IDS = ['tonemap', 'posterize', 'dither', 'outline', 'grain', 'colorGrade'] as const;
export type PostPassId = (typeof POST_PASS_IDS)[number];

/** マテリアルのシェーダ種別。 */
export const MATERIAL_SHADER_IDS = ['stylized-surface'] as const;
export type MaterialShaderId = (typeof MATERIAL_SHADER_IDS)[number];

/** 差し替え単位は要素種別。個別のオブジェクトを名指ししない。 */
export const MATERIAL_SLOT_IDS = ['floor', 'wall', 'stall', 'counter', 'gate'] as const;
export type MaterialSlotId = (typeof MATERIAL_SLOT_IDS)[number];

export interface MaterialSlot {
  shader: MaterialShaderId;
  params: Record<string, number>;
}

export interface PostPassConfig {
  id: PostPassId;
  enabled: boolean;
  strength: number;
  params: Record<string, number>;
}

export interface PresentationConfig {
  version: string;
  declared_in: string;
  confirmed: boolean;
  mode: RenderMode;
  palette: { confirmed: boolean; colors: Record<string, string> };
  lighting: {
    confirmed: boolean;
    ambientIntensity: number;
    keyIntensity: number;
    fogNear: number;
    fogFar: number;
  };
  materials: { confirmed: boolean; slots: Record<MaterialSlotId, MaterialSlot> };
  postprocess: {
    confirmed: boolean;
    enabled: boolean;
    /** どのモードに掛けるか。greybox 経路を素のまま残せるようにする。 */
    appliesTo: RenderMode[];
    passes: PostPassConfig[];
  };
  assets: { confirmed: boolean; textures: Record<string, string>; meshes: Record<string, string> };
  performance: { confirmed: boolean; frameBudgetMs: number; headlessFrameBudgetMs: number };
}

/** 画面に出す前に、まだ確定していない塊を数え上げる。 */
export function unconfirmedPresentation(config: PresentationConfig): string[] {
  const out: string[] = [];
  if (!config.palette.confirmed) out.push('palette');
  if (!config.lighting.confirmed) out.push('lighting');
  if (!config.materials.confirmed) out.push('materials');
  if (!config.postprocess.confirmed) out.push('postprocess');
  if (!config.assets.confirmed) out.push('assets');
  if (!config.performance.confirmed) out.push('performance');
  return out;
}

function numberMap(input: unknown, source: string, key: string): Record<string, number> {
  const raw = obj(input, source, key);
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith('$')) continue;
    out[name] = num(value, source, `${key}.${name}`);
  }
  return out;
}

function stringMap(input: unknown, source: string, key: string): Record<string, string> {
  const raw = obj(input, source, key);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith('$')) continue;
    out[name] = str(value, source, `${key}.${name}`);
  }
  return out;
}

export function validatePresentationConfig(input: unknown, source: string): PresentationConfig {
  const root = obj(input, source, '(root)');
  const palette = obj(root['palette'], source, 'palette');
  const lighting = obj(root['lighting'], source, 'lighting');
  const materials = obj(root['materials'], source, 'materials');
  const postprocess = obj(root['postprocess'], source, 'postprocess');
  const assets = obj(root['assets'], source, 'assets');
  const performance = obj(root['performance'], source, 'performance');

  const slotsRaw = obj(materials['slots'], source, 'materials.slots');
  const slots = {} as Record<MaterialSlotId, MaterialSlot>;
  for (const slotId of MATERIAL_SLOT_IDS) {
    const slot = obj(slotsRaw[slotId], source, `materials.slots.${slotId}`);
    slots[slotId] = {
      shader: oneOf(slot['shader'], MATERIAL_SHADER_IDS, source, `materials.slots.${slotId}.shader`),
      params: numberMap(slot['params'], source, `materials.slots.${slotId}.params`),
    };
  }
  for (const key of Object.keys(slotsRaw)) {
    if (key.startsWith('$')) continue;
    if (!MATERIAL_SLOT_IDS.includes(key as MaterialSlotId)) {
      throw new Error(`${source}: 未知のマテリアルスロット: ${key}（${MATERIAL_SLOT_IDS.join(' / ')}）`);
    }
  }

  const seenPasses = new Set<string>();
  const passes = arr(postprocess['passes'], source, 'postprocess.passes').map((v, i) => {
    const pass = obj(v, source, `postprocess.passes[${i}]`);
    const id = oneOf(pass['id'], POST_PASS_IDS, source, `postprocess.passes[${i}].id`);
    if (seenPasses.has(id)) throw new Error(`${source}: postprocess.passes に ${id} が重複している`);
    seenPasses.add(id);
    const strength = num(pass['strength'], source, `postprocess.passes[${i}].strength`);
    if (strength < 0 || strength > 1) {
      throw new Error(`${source}: postprocess.passes[${i}].strength は 0..1（実際: ${strength}）`);
    }
    return {
      id,
      enabled: bool(pass['enabled'], source, `postprocess.passes[${i}].enabled`),
      strength,
      params: numberMap(pass['params'], source, `postprocess.passes[${i}].params`),
    };
  });

  return {
    version: str(root['version'], source, 'version'),
    declared_in: str(root['declared_in'], source, 'declared_in'),
    confirmed: bool(root['confirmed'], source, 'confirmed'),
    mode: oneOf(root['mode'], ['greybox', 'stylized'] as const, source, 'mode'),
    palette: {
      confirmed: bool(palette['confirmed'], source, 'palette.confirmed'),
      colors: stringMap(palette['colors'], source, 'palette.colors'),
    },
    lighting: {
      confirmed: bool(lighting['confirmed'], source, 'lighting.confirmed'),
      ambientIntensity: num(lighting['ambientIntensity'], source, 'lighting.ambientIntensity'),
      keyIntensity: num(lighting['keyIntensity'], source, 'lighting.keyIntensity'),
      fogNear: num(lighting['fogNear'], source, 'lighting.fogNear'),
      fogFar: num(lighting['fogFar'], source, 'lighting.fogFar'),
    },
    materials: { confirmed: bool(materials['confirmed'], source, 'materials.confirmed'), slots },
    postprocess: {
      confirmed: bool(postprocess['confirmed'], source, 'postprocess.confirmed'),
      enabled: bool(postprocess['enabled'], source, 'postprocess.enabled'),
      appliesTo: arr(postprocess['appliesTo'], source, 'postprocess.appliesTo').map((v, i) =>
        oneOf(v, ['greybox', 'stylized'] as const, source, `postprocess.appliesTo[${i}]`),
      ),
      passes,
    },
    assets: {
      confirmed: bool(assets['confirmed'], source, 'assets.confirmed'),
      textures: stringMap(assets['textures'], source, 'assets.textures'),
      meshes: stringMap(assets['meshes'], source, 'assets.meshes'),
    },
    performance: {
      confirmed: bool(performance['confirmed'], source, 'performance.confirmed'),
      frameBudgetMs: num(performance['frameBudgetMs'], source, 'performance.frameBudgetMs'),
      headlessFrameBudgetMs: num(performance['headlessFrameBudgetMs'], source, 'performance.headlessFrameBudgetMs'),
    },
  };
}

/** 必要な色が揃っているか。欠けていたら既定値で補わずに落とす。 */
export function requireColor(config: PresentationConfig, key: string): string {
  const value = config.palette.colors[key];
  if (value === undefined || value === '') {
    throw new Error(`presentation config に色 ${key} が無い（palette.colors）`);
  }
  return value;
}
