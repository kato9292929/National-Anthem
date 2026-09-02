import type { MaterialSlotId } from '@na/shared';

/**
 * 画像 → メッシュ生成のアダプタ interface。
 * 実生成（Tripo / Meshy への実呼び出し）は区分B（加藤さん env・実キー要）。
 * 区分A ではこの interface と、ダミー .glb を出す placeholder アダプタだけを持つ。
 *
 * ダミーを実物に見せない: 生成結果には placeholder フラグと source を必ず残す。
 */

export interface MeshTarget {
  /** どの要素種別に入れるか。 */
  slot: MaterialSlotId;
  /** アセットの論理名（ファイル名の基）。 */
  name: string;
  /** 元にする参照画像の記述（実画像は区分B で入れる）。 */
  reference: string;
  /** greybox の箱に合わせる長辺（m）。 */
  fitLongestEdge: number;
}

export interface GeneratedMesh {
  target: MeshTarget;
  /** 出力 .glb の相対パス。 */
  glbPath: string;
  placeholder: boolean;
  source: string;
  /** 生成物のポリゴン数（tri）。placeholder は低ポリ。 */
  triangles: number;
  /** 1 回あたりの実測コスト（USD）。placeholder は 0。実生成は区分B で埋める。 */
  costUsd: number;
}

export interface MeshGeneratorStatus {
  id: string;
  mode: 'placeholder' | 'live';
  /** 実生成の確認が済んでいるか。区分B が未消化の間は false。 */
  verified: boolean;
  requires: string[];
  /** ライセンス状態。無料枠は Tripo 非商用 / Meshy CC BY。 */
  license: string;
  note: string;
}

export interface MeshGenerator {
  status(): MeshGeneratorStatus;
  generate(target: MeshTarget): Promise<GeneratedMesh>;
}

export class MeshGeneratorUnavailableError extends Error {
  override readonly name = 'MeshGeneratorUnavailableError';
  constructor(readonly missing: string[]) {
    super(
      '実メッシュ生成は未接続（区分B）。' +
        `不足: ${missing.join(' / ')}。ダミーを実物に見せないのでここで止める`,
    );
  }
}
