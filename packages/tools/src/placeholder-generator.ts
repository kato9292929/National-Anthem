import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MaterialSlotId } from '@na/shared';
import type { GeneratedMesh, MeshGenerator, MeshTarget } from './gen-types.js';
import { triangleCount, writeGlb, type BoxSpec } from './glb-writer.js';

/**
 * ダミー .glb を出す placeholder ジェネレータ（区分A の配管確認用）。
 * 実物のトポロジーではない箱の集合を出す。placeholder:true を必ず残し、実物に見せない。
 * 実生成（Tripo / Meshy）は区分B。
 */

/** 要素種別ごとの「それらしい」箱の組み方。実メッシュの代わりではなく、置き場の確認用。 */
function shapeFor(slot: MaterialSlotId): BoxSpec[] {
  switch (slot) {
    case 'stall':
      // 木枠＋台＋支柱。日除け布は awning 側にあるのでここは骨組みだけ。
      return [
        { cx: 0, cy: 0.5, cz: 0, sx: 1, sy: 0.1, sz: 0.8 },
        { cx: -0.45, cy: 0.75, cz: -0.35, sx: 0.08, sy: 0.5, sz: 0.08 },
        { cx: 0.45, cy: 0.75, cz: -0.35, sx: 0.08, sy: 0.5, sz: 0.08 },
        { cx: -0.45, cy: 0.75, cz: 0.35, sx: 0.08, sy: 0.5, sz: 0.08 },
        { cx: 0.45, cy: 0.75, cz: 0.35, sx: 0.08, sy: 0.5, sz: 0.08 },
        { cx: 0, cy: 1.0, cz: 0, sx: 1, sy: 0.06, sz: 0.8 },
      ];
    case 'wall':
      // 日干しレンガの積み。段をずらした 3 段。
      return [
        { cx: -0.3, cy: 0.2, cz: 0, sx: 0.55, sy: 0.35, sz: 0.5 },
        { cx: 0.3, cy: 0.2, cz: 0, sx: 0.55, sy: 0.35, sz: 0.5 },
        { cx: 0, cy: 0.55, cz: 0, sx: 0.55, sy: 0.35, sz: 0.5 },
        { cx: -0.35, cy: 0.9, cz: 0, sx: 0.45, sy: 0.35, sz: 0.5 },
        { cx: 0.35, cy: 0.9, cz: 0, sx: 0.45, sy: 0.35, sz: 0.5 },
      ];
    case 'gate':
      // 石の門柱＋まぐさ。
      return [
        { cx: -0.5, cy: 0.9, cz: 0, sx: 0.35, sy: 1.8, sz: 0.4 },
        { cx: 0.5, cy: 0.9, cz: 0, sx: 0.35, sy: 1.8, sz: 0.4 },
        { cx: 0, cy: 1.95, cz: 0, sx: 1.4, sy: 0.3, sz: 0.45 },
      ];
    case 'counter':
      return [
        { cx: 0, cy: 0.45, cz: 0, sx: 1.2, sy: 0.12, sz: 0.5 },
        { cx: 0, cy: 0.2, cz: 0.2, sx: 1.15, sy: 0.4, sz: 0.08 },
      ];
    case 'floor':
      // 敷石の凹凸。薄い板を格子に。
      return [
        { cx: -0.25, cy: 0, cz: -0.25, sx: 0.45, sy: 0.04, sz: 0.45 },
        { cx: 0.25, cy: 0, cz: -0.25, sx: 0.45, sy: 0.04, sz: 0.45 },
        { cx: -0.25, cy: 0, cz: 0.25, sx: 0.45, sy: 0.04, sz: 0.45 },
        { cx: 0.25, cy: 0.01, cz: 0.25, sx: 0.45, sy: 0.04, sz: 0.45 },
      ];
    default:
      return [{ cx: 0, cy: 0.5, cz: 0, sx: 1, sy: 1, sz: 1 }];
  }
}

export interface PlaceholderGeneratorOptions {
  /** .glb を書き出すディレクトリ。 */
  outputDir: string;
  now?: () => number;
}

export class PlaceholderMeshGenerator implements MeshGenerator {
  constructor(private readonly options: PlaceholderGeneratorOptions) {}

  status() {
    return {
      id: 'placeholder',
      mode: 'placeholder' as const,
      verified: false,
      requires: ['実生成は Tripo / Meshy の API キー（区分B）'],
      license: 'placeholder（自前生成の箱。ライセンス制約なし）',
      note: 'ダミー .glb。実物のトポロジーではない。placeholder:true を残す',
    };
  }

  generate(target: MeshTarget): Promise<GeneratedMesh> {
    const boxes = shapeFor(target.slot);
    const glb = writeGlb(boxes);
    const glbPath = join(this.options.outputDir, `${target.slot}-${target.name}.placeholder.glb`);
    mkdirSync(dirname(glbPath), { recursive: true });
    writeFileSync(glbPath, glb);
    return Promise.resolve({
      target,
      glbPath,
      placeholder: true,
      source: `placeholder (from: ${target.reference})`,
      triangles: triangleCount(boxes),
      costUsd: 0,
    });
  }
}
