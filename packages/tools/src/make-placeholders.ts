import { writeFileSync } from 'node:fs';
import { PlaceholderMeshGenerator } from './placeholder-generator.js';
import { MESH_TARGETS } from './targets.js';

/**
 * 区分A の配管確認用に、要素種別ごとのダミー .glb を出す。
 *   npm run assets:placeholders
 * これは実物ではない。生成した config スニペットにも placeholder:true を残す。
 */
async function main(): Promise<void> {
  const generator = new PlaceholderMeshGenerator({ outputDir: 'assets/meshes' });
  const meshes: Record<string, unknown> = {};

  console.log('[placeholders] ダミー .glb を生成（実物ではない）');
  for (const target of MESH_TARGETS) {
    const result = await generator.generate(target);
    const relative = result.glbPath.replace(/^.*\/assets\//, 'assets/');
    meshes[target.slot] = {
      url: relative,
      source: result.source,
      placeholder: result.placeholder,
      fitLongestEdge: target.fitLongestEdge,
      rotationDeg: { x: 0, y: 0, z: 0 },
    };
    console.log(`  ${target.slot.padEnd(8)} ${relative}  ${result.triangles} tri  $${result.costUsd}`);
  }

  // config に貼れる assets.meshes スニペットを出す（差し替えは加藤さん判断）。
  writeFileSync(
    'assets/meshes/placeholder-slots.json',
    `${JSON.stringify({ $comment: 'ダミー。実物に差し替えるまで placeholder:true。', meshes }, null, 2)}\n`,
  );
  console.log('[placeholders] config スニペット: assets/meshes/placeholder-slots.json');
  console.log('[placeholders] status:', JSON.stringify(generator.status()));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
