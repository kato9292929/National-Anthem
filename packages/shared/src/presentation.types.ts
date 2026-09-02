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

/**
 * パスごとに要るパラメータ。config 側で欠けていたら読み込み時に落とす
 * （ブラウザまで持ち越さない）。
 */
export const PASS_REQUIRED_PARAMS: Record<PostPassId, { params: string[]; colorParams: string[] }> = {
  tonemap: { params: ['exposure'], colorParams: [] },
  posterize: { params: ['levels'], colorParams: [] },
  dither: { params: ['scale'], colorParams: [] },
  outline: { params: ['threshold'], colorParams: [] },
  grain: { params: ['scale', 'speed'], colorParams: [] },
  colorGrade: { params: ['saturation', 'gamma', 'shadowLift'], colorParams: ['shadowColor'] },
};

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

/**
 * 要素種別に割り当てる生成メッシュ。
 * url が空なら未割り当て（greybox 形状を使う）。生成ツールは config には現れない。
 * ダミー（プレースホルダ）は placeholder:true を必ず残す。実物に見せない。
 */
export interface MeshAssetSlot {
  /** アセットの参照（相対パスや asset id）。空なら未割り当て。 */
  url: string;
  /** 生成物の由来。tool は生成ツール名、reference は元にした参照画像の記述。 */
  source: string;
  /** ダミーの .glb か。区分A の配管確認用は必ず true。 */
  placeholder: boolean;
  /** メッシュを greybox の箱に合わせる寸法（m）。長辺をこの値に正規化する。 */
  fitLongestEdge: number;
  /** 上向きの補正（度）。生成物の up 軸がまちまちなため。 */
  rotationDeg: { x: number; y: number; z: number };
}

export interface PostPassConfig {
  id: PostPassId;
  enabled: boolean;
  /** 効き量（0..1）。パスごとの内部スケールは shader 側に持つ。 */
  strength: number;
  params: Record<string, number>;
  /** 色で渡すパラメータ（暗部の寄せ先など）。無いパスもある。 */
  colorParams?: Record<string, string>;
}

/** 値の熟度。first-pass = 方向を翻訳しただけの一次値（要調整）。 */
export type TuningStatus = 'first-pass' | 'confirmed';

export interface TuningNote {
  status: TuningStatus;
  owner: string;
  /** どこから確定させるか（実参照など）。 */
  note: string;
}

export interface PresentationConfig {
  version: string;
  declared_in: string;
  confirmed: boolean;
  tuning: TuningNote;
  mode: RenderMode;
  palette: { confirmed: boolean; colors: Record<string, string> };
  lighting: {
    confirmed: boolean;
    ambientIntensity: number;
    /** 環境光の色（palette のキー名）。 */
    ambientColorKey: string;
    keyIntensity: number;
    /** キーライトの色（palette のキー名）。 */
    keyColorKey: string;
    /** 低い斜光の仰角（度）。 */
    keyElevationDeg: number;
    /** 方位角（度）。実参照から確定するまでは現状維持の値。 */
    keyAzimuthDeg: number;
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
  assets: {
    confirmed: boolean;
    textures: Record<string, string>;
    /** 要素種別 → 生成メッシュの割り当て。空なら greybox 形状のまま。 */
    meshes: Record<MaterialSlotId, MeshAssetSlot>;
  };
  performance: { confirmed: boolean; frameBudgetMs: number; headlessFrameBudgetMs: number };
}

/** 一次値のまま動いているか。true の間は「要調整」。 */
export function isFirstPass(config: PresentationConfig): boolean {
  return config.tuning.status === 'first-pass';
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

/** 空文字を許す str（url は空＝未割り当て）。 */
function str2(value: unknown, source: string, key: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${source}: ${key} は文字列である必要がある`);
  }
  return value;
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
    const colorParams = pass['colorParams'];
    const parsedParams = numberMap(pass['params'], source, `postprocess.passes[${i}].params`);
    const parsedColors =
      colorParams === undefined ? {} : stringMap(colorParams, source, `postprocess.passes[${i}].colorParams`);
    const required = PASS_REQUIRED_PARAMS[id];
    for (const key of required.params) {
      if (parsedParams[key] === undefined) {
        throw new Error(`${source}: postprocess.passes[${i}](${id}).params に ${key} が無い`);
      }
    }
    for (const key of required.colorParams) {
      if (parsedColors[key] === undefined) {
        throw new Error(`${source}: postprocess.passes[${i}](${id}).colorParams に ${key} が無い`);
      }
    }
    return {
      id,
      enabled: bool(pass['enabled'], source, `postprocess.passes[${i}].enabled`),
      strength,
      params: parsedParams,
      ...(colorParams === undefined ? {} : { colorParams: parsedColors }),
    };
  });

  return {
    version: str(root['version'], source, 'version'),
    declared_in: str(root['declared_in'], source, 'declared_in'),
    confirmed: bool(root['confirmed'], source, 'confirmed'),
    tuning: (() => {
      const tuning = obj(root['tuning'], source, 'tuning');
      const status = oneOf(tuning['status'], ['first-pass', 'confirmed'] as const, source, 'tuning.status');
      if (status === 'confirmed' && !bool(root['confirmed'], source, 'confirmed')) {
        throw new Error(`${source}: tuning.status が confirmed なのに confirmed:false のまま`);
      }
      return {
        status,
        owner: str(tuning['owner'], source, 'tuning.owner'),
        note: str(tuning['note'], source, 'tuning.note'),
      };
    })(),
    mode: oneOf(root['mode'], ['greybox', 'stylized'] as const, source, 'mode'),
    palette: {
      confirmed: bool(palette['confirmed'], source, 'palette.confirmed'),
      colors: stringMap(palette['colors'], source, 'palette.colors'),
    },
    lighting: {
      confirmed: bool(lighting['confirmed'], source, 'lighting.confirmed'),
      ambientIntensity: num(lighting['ambientIntensity'], source, 'lighting.ambientIntensity'),
      ambientColorKey: str(lighting['ambientColorKey'], source, 'lighting.ambientColorKey'),
      keyIntensity: num(lighting['keyIntensity'], source, 'lighting.keyIntensity'),
      keyColorKey: str(lighting['keyColorKey'], source, 'lighting.keyColorKey'),
      keyElevationDeg: num(lighting['keyElevationDeg'], source, 'lighting.keyElevationDeg'),
      keyAzimuthDeg: num(lighting['keyAzimuthDeg'], source, 'lighting.keyAzimuthDeg'),
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
      meshes: (() => {
        const meshesRaw = obj(assets['meshes'], source, 'assets.meshes');
        const out = {} as Record<MaterialSlotId, MeshAssetSlot>;
        for (const key of Object.keys(meshesRaw)) {
          if (key.startsWith('$')) continue;
          if (!MATERIAL_SLOT_IDS.includes(key as MaterialSlotId)) {
            throw new Error(`${source}: 未知のメッシュスロット: ${key}（${MATERIAL_SLOT_IDS.join(' / ')}）`);
          }
        }
        for (const slot of MATERIAL_SLOT_IDS) {
          const raw = meshesRaw[slot];
          if (raw === undefined) {
            out[slot] = { url: '', source: '', placeholder: false, fitLongestEdge: 0, rotationDeg: { x: 0, y: 0, z: 0 } };
            continue;
          }
          const o = obj(raw, source, `assets.meshes.${slot}`);
          const url = str2(o['url'], source, `assets.meshes.${slot}.url`);
          const rot = obj(o['rotationDeg'], source, `assets.meshes.${slot}.rotationDeg`);
          out[slot] = {
            url,
            source: str2(o['source'], source, `assets.meshes.${slot}.source`),
            placeholder: bool(o['placeholder'], source, `assets.meshes.${slot}.placeholder`),
            fitLongestEdge: num(o['fitLongestEdge'], source, `assets.meshes.${slot}.fitLongestEdge`),
            rotationDeg: {
              x: num(rot['x'], source, `assets.meshes.${slot}.rotationDeg.x`),
              y: num(rot['y'], source, `assets.meshes.${slot}.rotationDeg.y`),
              z: num(rot['z'], source, `assets.meshes.${slot}.rotationDeg.z`),
            },
          };
          // url があるのに placeholder かどうか未定、を許さない（実物に見せないため）。
          if (url !== '' && o['placeholder'] === undefined) {
            throw new Error(`${source}: assets.meshes.${slot} に placeholder が無い（ダミーか実物かを明示する）`);
          }
        }
        return out;
      })(),
    },
    performance: {
      confirmed: bool(performance['confirmed'], source, 'performance.confirmed'),
      frameBudgetMs: num(performance['frameBudgetMs'], source, 'performance.frameBudgetMs'),
      headlessFrameBudgetMs: num(performance['headlessFrameBudgetMs'], source, 'performance.headlessFrameBudgetMs'),
    },
  };
}

/** 割り当て済みのメッシュスロット（url がある）を返す。 */
export function assignedMeshSlots(config: PresentationConfig): { slot: MaterialSlotId; asset: MeshAssetSlot }[] {
  return MATERIAL_SLOT_IDS.map((slot) => ({ slot, asset: config.assets.meshes[slot] })).filter(
    (entry) => entry.asset.url !== '',
  );
}

/** 必要な色が揃っているか。欠けていたら既定値で補わずに落とす。 */
export function requireColor(config: PresentationConfig, key: string): string {
  const value = config.palette.colors[key];
  if (value === undefined || value === '') {
    throw new Error(`presentation config に色 ${key} が無い（palette.colors）`);
  }
  return value;
}
