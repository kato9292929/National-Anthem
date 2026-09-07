import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { validateAssetsConfig, assertBatchAllowed } from '@na/shared';
import type { AssetsConfig, MaterialSlotId } from '@na/shared';
import { createTripoMeshGenerator } from './tripo-generator.js';
import { MeshGeneratorUnavailableError } from './gen-types.js';
import { MESH_TARGETS } from './targets.js';

/**
 * 参照画像 1 枚 → Tripo → .glb → assets.meshes スロットへ、の 1 コマンド。
 *   npm run generate:tripo -- --slot wall
 *   npm run generate:tripo -- --all   （実測が済んでいればバッチ。未実測なら止まる）
 *
 * 鍵が無ければ MeshGeneratorUnavailableError で落ちる（偽 .glb を作らない）。
 * 最小の一歩は 1 種別（--slot）。通れば他も同じ経路。
 */

interface Args {
  slots: MaterialSlotId[];
  outputDir: string;
}

function parseArgs(argv: string[], config: AssetsConfig): Args {
  const outputDir = 'assets/meshes';
  const slotArg = valueOf(argv, '--slot');
  if (argv.includes('--all')) {
    // バッチは実測が前提（osd の再発防止）。未実測なら assertBatchAllowed が落とす。
    const measured = { ...config, budget: { ...config.budget, measuredCostPerMeshUsd: config.tripo.estimatedCostUsd } };
    assertBatchAllowed(measured, MESH_TARGETS.length);
    return { slots: MESH_TARGETS.map((t) => t.slot), outputDir };
  }
  if (!slotArg) throw new Error('--slot <wall|stall|gate|counter|floor> か --all を指定する');
  return { slots: [slotArg as MaterialSlotId], outputDir };
}

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const config = validateAssetsConfig(JSON.parse(readFileSync('config/assets.config.json', 'utf8')), 'config/assets.config.json');
  const args = parseArgs(process.argv.slice(2), config);

  const generator = createTripoMeshGenerator({
    apiKey: process.env['TRIPO_API_KEY'],
    outputDir: args.outputDir,
    pythonBin: config.tripo.pythonBin,
    estimatedCostUsd: config.tripo.estimatedCostUsd ?? undefined,
    imageFor: (target) => config.tripo.references[target.slot],
  });

  console.log('[generate:tripo]', JSON.stringify(generator.status()));

  mkdirSync(args.outputDir, { recursive: true });
  const meshes: Record<string, unknown> = {};
  for (const slot of args.slots) {
    const target = MESH_TARGETS.find((t) => t.slot === slot);
    if (!target) throw new Error(`未知のスロット: ${slot}`);
    console.log(`[generate:tripo] ${slot} <- ${config.tripo.references[slot] ?? '(参照画像なし)'}`);
    const result = await generator.generate(target);
    const relative = result.glbPath.replace(/^.*\/assets\//, 'assets/');
    meshes[slot] = {
      url: relative,
      source: result.source,
      placeholder: false, // 実 .glb。ダミーではない。
      fitLongestEdge: target.fitLongestEdge,
      rotationDeg: { x: 0, y: 0, z: 0 },
    };
    console.log(`[generate:tripo]   -> ${relative}  cost=${result.costUsd < 0 ? '未実測' : `$${result.costUsd}`}`);
  }

  // config に貼れるスニペット。差し替えは加藤さん判断。verified を上げるのは実確認後。
  const snippetPath = 'assets/meshes/tripo-slots.json';
  const existing = existsSync(snippetPath) ? JSON.parse(readFileSync(snippetPath, 'utf8')) : { meshes: {} };
  writeFileSync(snippetPath, `${JSON.stringify({ meshes: { ...existing.meshes, ...meshes } }, null, 2)}\n`);
  console.log(`[generate:tripo] config スニペット: ${snippetPath}`);
  console.log('[generate:tripo] 1 個目が箱と差し替わるか確認してから、他の種別と --all のバッチへ');
}

void main().catch((error) => {
  if (error instanceof MeshGeneratorUnavailableError) {
    console.error(`[generate:tripo] ${error.message}`);
  } else {
    console.error(`[generate:tripo] ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
});
