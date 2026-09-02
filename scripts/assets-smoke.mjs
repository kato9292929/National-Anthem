/**
 * 生成アセット・パイプライン（区分A）のスモーク。
 * placeholder .glb を assets.meshes に割り当てた config ツリーで:
 *   - .glb が読める（GLTFLoader）
 *   - greybox の箱と生成メッシュを M でトグルできる
 *   - stylize-on-top（マテリアルが presentation の stylized）
 *   - budget 再計測（fail-loud）
 * ダミーを実物に見せない（placeholder フラグが立っていること）を確認する。
 *   npm run assets:smoke
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// placeholders を作る（無ければ）。
if (!existsSync('assets/meshes/placeholder-slots.json')) {
  const gen = spawnSync('npm', ['run', 'assets:placeholders'], { stdio: 'inherit' });
  if (gen.status !== 0) process.exit(gen.status ?? 1);
}

const tree = mkdtempSync(join(tmpdir(), 'na-assets-'));
try {
  cpSync('config', join(tree, 'config'), { recursive: true });
  cpSync('world', join(tree, 'world'), { recursive: true });

  // placeholder のスロットを presentation config に差し込む。
  const presentationPath = join(tree, 'config/presentation.config.json');
  const presentation = JSON.parse(readFileSync(presentationPath, 'utf8'));
  const slots = JSON.parse(readFileSync('assets/meshes/placeholder-slots.json', 'utf8'));
  presentation.mode = 'stylized';
  presentation.assets.meshes = slots.meshes;
  writeFileSync(presentationPath, `${JSON.stringify(presentation, null, 2)}\n`);

  console.log(`[assets-smoke] 差し替えツリー: ${tree}`);
  const result = spawnSync(process.execPath, ['scripts/smoke.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NA_WORLD_CONFIG: presentationPath.replace('config/presentation.config.json', 'world/world.config.json'),
      NA_SMOKE_PORT: process.env.NA_ASSETS_PORT ?? '8803',
      NA_SMOKE_BUDGET_ADVISORY: '1',
      NA_SMOKE_SHOT: 'artifacts/assets-stylized.png',
      NA_SMOKE_GREYBOX_SHOT: 'artifacts/assets-greybox.png',
      NA_SMOKE_ASSETS: '1',
      NA_SMOKE_BUDGET_OUT: 'artifacts/frame-budget-assets.json',
    },
  });
  if (result.status !== 0) {
    console.error('[assets-smoke] 失敗');
    process.exit(result.status ?? 1);
  }
  console.log('[assets-smoke] 生成メッシュのスロット差し替えが config 差し替えだけで通る（ソース修正なし）');
} finally {
  rmSync(tree, { recursive: true, force: true });
}
