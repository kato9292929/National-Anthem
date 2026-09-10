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

/**
 * ワールド全体の環境メッシュ（Blender 出力の 1 シーン）。
 * 要素種別ごとの差し替え（meshes）とは別に、シーンを丸ごと 1 個読み込む受け口。
 * url が空なら未割り当て（greybox のまま）。placeholder ではない実メッシュでも placeholder:false。
 */
export interface EnvironmentAsset {
  url: string;
  source: string;
  /** ダミーか。Blender 生成の実メッシュは false。実物に見せないためのフラグ自体は残す。 */
  placeholder: boolean;
  /** ワールドの footprint（greybox の床）に合わせて自動スケールするか。 */
  fitToWorld: boolean;
  /** fit 時の余白率（1=ぴったり / <1 で内側に寄せる / >1 ではみ出す）。 */
  fitMargin: number;
  /** 手動オフセット・向き・追加スケール（fit の後に掛ける）。 */
  position: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
  scale: number;
  /** true なら stylized マテリアルを上掛け。既定 false（glb 本来の色を見せる）。 */
  stylizeOnTop: boolean;
  /**
   * true なら glb のマテリアルを unlit（MeshBasic）へ変換して本来の色をそのまま出す。
   * greybox の自己発光シェーダに合わせて景色の光量を絞っているため、PBR のままだと暗く沈む。
   * 既定 true（Blender の色を確実に見せる）。stylizeOnTop が true のときは無視。
   */
  unlit: boolean;
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

/**
 * 背景レイヤー（Marble / Atlas の splat）。
 * 見た目専用。前景（scene graph・当たり判定・対話）とは融合しない。
 */
export interface BackgroundLayerConfig {
  /** 背景 splat を出すか。無ければ前景だけで動く。 */
  enabled: boolean;
  /** splat ファイルの参照（.spz / .ply / .splat / .ksplat / .sog）。空なら未割り当て。 */
  splatUrl: string;
  /** 当たり判定の .glb（Collider Builder 出力）。splat とは別物。空なら床/壁は前景側だけ。 */
  colliderUrl: string;
  /** ダミー splat か。実物に見せないため必ず持つ。 */
  placeholder: boolean;
  /** 背景の配置（前景の奥に置く基準）。 */
  position: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
  scale: number;
  /** 前景と同じポスプロ（colorGrade / grain）を背景にも掛けるか。既定は掛けない（加藤さん判断）。 */
  applyPostprocess: boolean;
  source: string;
}

export interface PresentationConfig {
  version: string;
  declared_in: string;
  confirmed: boolean;
  tuning: TuningNote;
  mode: RenderMode;
  background: BackgroundLayerConfig;
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
    /** ワールド全体の環境メッシュ（1 シーン）。url が空なら未割り当て。 */
    environment: EnvironmentAsset;
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
    background: (() => {
      const bg = obj(root['background'], source, 'background');
      const pos = obj(bg['position'], source, 'background.position');
      const rot = obj(bg['rotationDeg'], source, 'background.rotationDeg');
      const splatUrl = str2(bg['splatUrl'], source, 'background.splatUrl');
      // url があるのに placeholder 未指定を許さない（実物に見せないため）。
      if (splatUrl !== '' && bg['placeholder'] === undefined) {
        throw new Error(`${source}: background に placeholder が無い（ダミーか実物かを明示する）`);
      }
      return {
        enabled: bool(bg['enabled'], source, 'background.enabled'),
        splatUrl,
        colliderUrl: str2(bg['colliderUrl'], source, 'background.colliderUrl'),
        placeholder: bg['placeholder'] === undefined ? false : bool(bg['placeholder'], source, 'background.placeholder'),
        position: {
          x: num(pos['x'], source, 'background.position.x'),
          y: num(pos['y'], source, 'background.position.y'),
          z: num(pos['z'], source, 'background.position.z'),
        },
        rotationDeg: {
          x: num(rot['x'], source, 'background.rotationDeg.x'),
          y: num(rot['y'], source, 'background.rotationDeg.y'),
          z: num(rot['z'], source, 'background.rotationDeg.z'),
        },
        scale: num(bg['scale'], source, 'background.scale'),
        applyPostprocess: bool(bg['applyPostprocess'], source, 'background.applyPostprocess'),
        source: str2(bg['source'], source, 'background.source'),
      };
    })(),
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
      environment: parseEnvironmentAsset(assets['environment'], source),
    },
    performance: {
      confirmed: bool(performance['confirmed'], source, 'performance.confirmed'),
      frameBudgetMs: num(performance['frameBudgetMs'], source, 'performance.frameBudgetMs'),
      headlessFrameBudgetMs: num(performance['headlessFrameBudgetMs'], source, 'performance.headlessFrameBudgetMs'),
    },
  };
}

/**
 * 環境メッシュの受け口を読む。省略時は未割り当て（空）として扱う（既存 config を壊さない）。
 * url があるのに placeholder が未指定、を許さない（ダミーか実物かを明示する）。
 */
function parseEnvironmentAsset(raw: unknown, source: string): EnvironmentAsset {
  const empty: EnvironmentAsset = {
    url: '',
    source: '',
    placeholder: false,
    fitToWorld: true,
    fitMargin: 1,
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: 1,
    stylizeOnTop: false,
    unlit: true,
  };
  if (raw === undefined) return empty;
  const o = obj(raw, source, 'assets.environment');
  const url = str2(o['url'], source, 'assets.environment.url');
  if (url === '') return empty;
  if (o['placeholder'] === undefined) {
    throw new Error(`${source}: assets.environment に placeholder が無い（ダミーか実物かを明示する）`);
  }
  const pos = obj(o['position'], source, 'assets.environment.position');
  const rot = obj(o['rotationDeg'], source, 'assets.environment.rotationDeg');
  return {
    url,
    source: str2(o['source'], source, 'assets.environment.source'),
    placeholder: bool(o['placeholder'], source, 'assets.environment.placeholder'),
    fitToWorld: bool(o['fitToWorld'], source, 'assets.environment.fitToWorld'),
    fitMargin: num(o['fitMargin'], source, 'assets.environment.fitMargin'),
    position: {
      x: num(pos['x'], source, 'assets.environment.position.x'),
      y: num(pos['y'], source, 'assets.environment.position.y'),
      z: num(pos['z'], source, 'assets.environment.position.z'),
    },
    rotationDeg: {
      x: num(rot['x'], source, 'assets.environment.rotationDeg.x'),
      y: num(rot['y'], source, 'assets.environment.rotationDeg.y'),
      z: num(rot['z'], source, 'assets.environment.rotationDeg.z'),
    },
    scale: num(o['scale'], source, 'assets.environment.scale'),
    stylizeOnTop: bool(o['stylizeOnTop'], source, 'assets.environment.stylizeOnTop'),
    // 省略時は unlit（既定で色を確実に見せる）。
    unlit: o['unlit'] === undefined ? true : bool(o['unlit'], source, 'assets.environment.unlit'),
  };
}

/** 環境メッシュ（1 シーン）が割り当てられているか。 */
export function hasEnvironmentMesh(config: PresentationConfig): boolean {
  return config.assets.environment.url !== '';
}

/** 背景 splat が割り当てられているか。 */
export function hasBackgroundSplat(config: PresentationConfig): boolean {
  return config.background.enabled && config.background.splatUrl !== '';
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
