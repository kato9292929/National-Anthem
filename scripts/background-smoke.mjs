/**
 * 背景 splat ブリッジ（区分A）のスモーク。
 * placeholder splat（procedural）を背景に割り当てた config ツリーで一周する:
 *   Spark が前景 scene に共存する / 背景は前景の奥 / トグル / collider は分離 /
 *   budget 再計測（fail-loud）/ ダミーをダミーとして扱う。
 * 実 splat（Marble / Atlas）は区分B。
 *   npm run bg:smoke
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tree = mkdtempSync(join(tmpdir(), 'na-bg-'));
try {
  cpSync('config', join(tree, 'config'), { recursive: true });
  cpSync('world', join(tree, 'world'), { recursive: true });

  const presentationPath = join(tree, 'config/presentation.config.json');
  const presentation = JSON.parse(readFileSync(presentationPath, 'utf8'));
  presentation.background = {
    ...presentation.background,
    enabled: true,
    splatUrl: 'placeholder:procedural',
    placeholder: true,
    source: 'placeholder（procedural point cloud・実物ではない）',
  };
  writeFileSync(presentationPath, `${JSON.stringify(presentation, null, 2)}\n`);

  console.log(`[bg-smoke] 差し替えツリー: ${tree}`);
  const result = spawnSync(process.execPath, ['scripts/smoke.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NA_WORLD_CONFIG: join(tree, 'world/world.config.json'),
      NA_SMOKE_PORT: process.env.NA_BG_PORT ?? '8804',
      NA_SMOKE_BUDGET_ADVISORY: '1',
      NA_SMOKE_BG: '1',
      NA_SMOKE_SHOT: 'artifacts/bg-front.png',
      NA_SMOKE_GREYBOX_SHOT: 'artifacts/bg-greybox.png',
      NA_SMOKE_BG_SHOT: 'artifacts/background-splat.png',
      NA_SMOKE_BUDGET_OUT: 'artifacts/frame-budget-bg.json',
    },
  });
  if (result.status !== 0) {
    console.error('[bg-smoke] 失敗');
    process.exit(result.status ?? 1);
  }
  console.log('[bg-smoke] 背景 splat が config 差し替えだけで前景の奥に乗る（ソース修正なし）');
} finally {
  rmSync(tree, { recursive: true, force: true });
}
