import type { MeshTarget } from './gen-types.js';

/**
 * 生成対象の一覧。参照画像の選定と採否は加藤さん。
 * ここにあるのは「どの要素種別に何を起こすか」の骨組みだけ。
 */
export const MESH_TARGETS: MeshTarget[] = [
  { slot: 'wall', name: 'mudbrick-module', reference: '古代ウルの日干しレンガ建築モジュール', fitLongestEdge: 4.5 },
  { slot: 'stall', name: 'market-stall', reference: 'シュメール市場の stall（木枠＋日除け）', fitLongestEdge: 3.2 },
  { slot: 'gate', name: 'stone-gate', reference: '石の門柱とまぐさ', fitLongestEdge: 3.2 },
  { slot: 'counter', name: 'wood-counter', reference: '木のカウンター', fitLongestEdge: 3.2 },
  { slot: 'floor', name: 'paving', reference: '敷石・土の地面', fitLongestEdge: 4.0 },
];
