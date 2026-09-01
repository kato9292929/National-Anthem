/**
 * config を差し替えるだけで反映されることを、別ツリーで確かめる。
 * ソースは一切触らない。ビジュアル確定後に presentation 層を重ねるだけで入る建て付けの確認でもある。
 *
 *   npm run smoke:swap
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tree = mkdtempSync(join(tmpdir(), 'na-config-swap-'));
try {
  cpSync('config', join(tree, 'config'), { recursive: true });
  cpSync('world', join(tree, 'world'), { recursive: true });

  // 1. 固有名を確定させる（未確定ラベルが消えるはず）
  const worldPath = join(tree, 'world/world.config.json');
  const world = JSON.parse(readFileSync(worldPath, 'utf8'));
  world.naming.market = { value: '差し替え市場', confirmed: true, owner: 'kato' };
  world.naming.district = { value: '差し替え地区', confirmed: true, owner: 'kato' };
  // 2. 取引カテゴリを増やす（stall が増えるはず）
  world.stall_categories.imports.push({ id: 'bitumen', label_ja: '瀝青', sources_ja: ['ヒート方面'] });
  world.stall_categories.exports.push({ id: 'reed', label_ja: '葦・葦製品' });
  writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`);

  // 3. room の数・名前・しきい値を変える（門の数と要求値が変わるはず）
  const roomsPath = join(tree, 'config/rooms.config.json');
  const rooms = JSON.parse(readFileSync(roomsPath, 'utf8'));
  rooms.rooms = [
    { ...rooms.rooms[0], label_ja: '表の広場' },
    { ...rooms.rooms[1], label_ja: '差し替えの間', minStanding: 26, minImpressions: 1 },
  ];
  writeFileSync(roomsPath, `${JSON.stringify(rooms, null, 2)}\n`);

  // 4. 市場の連関と stall 分布も変える（伝播と軒数が変わるはず）
  const marketPath = join(tree, 'config/market.config.json');
  const market = JSON.parse(readFileSync(marketPath, 'utf8'));
  market.stalls.perCategory = 2;
  writeFileSync(marketPath, `${JSON.stringify(market, null, 2)}\n`);

  // 5. 見た目も差し替える（モード・パス構成・強度・色）。ソースは触らない。
  const presentationPath = join(tree, 'config/presentation.config.json');
  const presentation = JSON.parse(readFileSync(presentationPath, 'utf8'));
  presentation.mode = 'stylized';
  presentation.palette.colors.floor = '#4a3f35';
  presentation.palette.colors.wall = '#2b2622';
  presentation.materials.slots.floor.params = { bands: 4, rim: 0.15, warp: 0.03, tint: 0.05 };
  presentation.materials.slots.stall.params = { bands: 3, rim: 0.25, warp: 0.02, tint: 0.08 };
  presentation.postprocess.passes = [
    { id: 'posterize', enabled: true, strength: 0.6, params: { steps: 6 } },
    { id: 'outline', enabled: true, strength: 0.5, params: { threshold: 0.15 } },
    { id: 'grain', enabled: true, strength: 0.06, params: { scale: 3, speed: 0.2 } },
  ];
  writeFileSync(presentationPath, `${JSON.stringify(presentation, null, 2)}\n`);

  console.log(`[swap] 差し替えツリー: ${tree}`);
  const result = spawnSync(process.execPath, ['scripts/smoke.mjs'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NA_WORLD_CONFIG: worldPath,
      NA_SMOKE_PORT: process.env.NA_SMOKE_SWAP_PORT ?? '8802',
      // 重いパス構成を意図的に入れるので、予算は advisory（実測値は必ず出す）。
      NA_SMOKE_BUDGET_ADVISORY: '1',
      NA_SMOKE_BUDGET_OUT: 'artifacts/frame-budget-swap.json',
      NA_SMOKE_SHOT: 'artifacts/stylized-swap.png',
      NA_SMOKE_GREYBOX_SHOT: 'artifacts/greybox-swap.png',
    },
  });
  if (result.status !== 0) {
    console.error('[swap] 差し替えツリーで smoke が失敗した');
    process.exit(result.status ?? 1);
  }
  console.log('[swap] screenshot: artifacts/stylized-swap.png');
  console.log('[swap] config 差し替えだけで反映される（ソース修正なし）');
} finally {
  rmSync(tree, { recursive: true, force: true });
}
