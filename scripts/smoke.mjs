/**
 * M2 の受け入れを実環境で確認する。
 *  - サーバ（M1）を立て、ビルド済みクライアントを同一オリジンで配信
 *  - Chromium で開き、stall が config のカテゴリを反映しているか
 *  - 表示している市場値が M1 由来か（tick が進む）
 *  - 実際に歩けるか、フレーム予算に収まるか
 * 失敗したら非ゼロで落ちる（黙って通さない）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = process.env.NA_SMOKE_PORT ?? '8799';
const BASE = `http://127.0.0.1:${PORT}`;
// NA_WORLD_CONFIG が指定されていれば、サーバと期待値の双方でそれを使う（差し替えの確認用）。
const configPath = process.env.NA_WORLD_CONFIG
  ? new URL(process.env.NA_WORLD_CONFIG, `file://${process.cwd()}/`)
  : new URL('../world/world.config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const expectedIds = [
  ...config.stall_categories.imports.map((c) => c.id),
  ...config.stall_categories.exports.map((c) => c.id),
];
/** ヘッドレス（SwiftShader）でのフレーム予算。実機 GPU より緩い。 */
const FRAME_BUDGET_MS = Number(process.env.NA_SMOKE_FRAME_BUDGET_MS ?? 50);

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const server = spawn(process.execPath, ['packages/server/dist/index.js'], {
  env: {
    ...process.env,
    NA_MARKET_SEED: 'na-smoke-0001',
    NA_SERVER_PORT: PORT,
    NA_SERVE_CLIENT: '1',
    ...(process.env.NA_WORLD_CONFIG ? { NA_WORLD_CONFIG: process.env.NA_WORLD_CONFIG } : {}),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));

const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

try {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* 起動待ち */
    }
    if (i > 100) throw new Error('サーバが起動しない');
    await sleep(100);
  }

  // 環境に用意済みの Chromium を使う（playwright install はしない）。
  const preinstalled = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
  const executablePath = preinstalled.find((p) => existsSync(p));
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__na_debug !== undefined, null, { timeout: 15000 });

  const debug = await page.evaluate(() => ({
    stallCount: window.__na_debug.stallCount,
    categoryIds: window.__na_debug.categoryIds,
    marketSource: window.__na_debug.marketSource,
    unconfirmedNames: window.__na_debug.unconfirmedNames,
  }));
  check(
    JSON.stringify(debug.categoryIds) === JSON.stringify(expectedIds),
    'stall が config の stall_categories を反映する',
    `${debug.categoryIds.join(', ')}`,
  );
  check(debug.marketSource === 'server', '市場値の出所はサーバ（クライアントは市場を持たない）');

  await page.waitForFunction(() => window.__na_debug.tick !== null, null, { timeout: 10000 });
  const tick1 = await page.evaluate(() => window.__na_debug.tick);
  await sleep(2500);
  const tick2 = await page.evaluate(() => window.__na_debug.tick);
  check(tick2 > tick1, '表示中の市場が時間で動く（M1 由来）', `tick ${tick1} -> ${tick2}`);

  const hudText = await page.locator('#panel-market').innerText();
  const stateRes = await (await fetch(`${BASE}/api/market/state`)).json();
  const firstItem = stateRes.items[0];
  check(hudText.includes(firstItem.label_ja), 'HUD がサーバの品目を表示する', firstItem.label_ja);

  // 歩けること: 入力で実際に位置が動き、stall を抜けない。
  const walk = await page.evaluate(async () => {
    const hold = (codes, ms) =>
      new Promise((resolve) => {
        for (const code of codes) window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        setTimeout(() => {
          for (const code of codes) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
          resolve();
        }, ms);
      });

    // 通路の南端から前進する。
    window.__na_debug.moveTo(0, 12);
    const from = window.__na_debug.position();
    await hold(['KeyW'], 1200);
    const to = window.__na_debug.position();

    // stall の正面へ置いて focus を見る。
    const stall = window.__na_debug.stallPositions[0];
    window.__na_debug.moveTo(stall.x < 0 ? stall.x + 2.6 : stall.x - 2.6, stall.z);
    await new Promise((r) => setTimeout(r, 120));
    const focused = window.__na_debug.focusedCategoryId();

    // stall へ向かって歩き続けても中には入れない。
    const before = window.__na_debug.position();
    await hold([stall.x < 0 ? 'KeyA' : 'KeyD'], 900);
    const after = window.__na_debug.position();

    return {
      from,
      to,
      focused,
      expectedFocus: stall.categoryId,
      stallX: stall.x,
      blockedAt: after,
      approachedFrom: before,
      frameMs: window.__na_debug.averageFrameMs,
      fps: window.__na_debug.fps,
    };
  });

  const traveled = Math.hypot(walk.to.x - walk.from.x, walk.to.z - walk.from.z);
  check(traveled > 2, '一人称で歩ける（入力で位置が動く）', `${traveled.toFixed(2)}m 前進`);
  check(
    walk.focused === walk.expectedFocus,
    'stall の前に立つと対象が決まる',
    `focus=${walk.focused ?? 'なし'}`,
  );
  const penetrated = Math.abs(walk.blockedAt.x) > Math.abs(walk.stallX) - 0.5;
  check(!penetrated, 'stall を通り抜けない', `x=${walk.blockedAt.x.toFixed(2)} vs stall x=${walk.stallX}`);
  check(walk.frameMs > 0, 'フレームが回っている', `${walk.frameMs.toFixed(1)}ms / ${walk.fps.toFixed(0)}fps`);
  check(
    walk.frameMs < FRAME_BUDGET_MS,
    `フレーム予算内（< ${FRAME_BUDGET_MS}ms, headless SwiftShader）`,
    `${walk.frameMs.toFixed(1)}ms`,
  );

  check(pageErrors.length === 0, 'ページエラーが無い', pageErrors.join(' | '));

  const hudName = await page.locator('#panel-hud h2').innerText();
  const expectedName = config.naming.market.confirmed
    ? config.naming.market.value
    : `${config.naming.market.value}（未確定）`;
  check(hudName.includes(expectedName), 'HUD の市場名は config 由来（未確定はラベル付き）', hudName.replace(/\n/g, ' '));

  // 確認用に通路の南端から市場全体を撮る。
  await page.evaluate(() => window.__na_debug.moveTo(0, 13));
  await sleep(400);
  // M3: standing が room gate に効く（mock で一周）。
  const gatesBefore = await page.evaluate(() => window.__na_debug.gates());
  check(gatesBefore.length > 0, 'standing で開閉する門が立っている', `${gatesBefore.length} 門`);
  check(
    gatesBefore.every((g) => !g.open),
    '初期 standing では門が閉じている',
    gatesBefore.map((g) => `${g.roomId}:${g.open ? '開' : '閉'}`).join(', '),
  );

  const blockedByGate = await page.evaluate(async () => {
    const hold = (codes, ms) =>
      new Promise((resolve) => {
        for (const code of codes) window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        setTimeout(() => {
          for (const code of codes) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
          resolve();
        }, ms);
      });
    const gate = window.__na_debug.gates()[0];
    window.__na_debug.moveTo(gate.x, gate.z + 3);
    await hold(['KeyW'], 1400);
    return { ...window.__na_debug.position(), roomId: gate.roomId, gateZ: gate.z };
  });
  check(
    blockedByGate.z > blockedByGate.gateZ,
    '閉じた門は通れない',
    `z=${blockedByGate.z.toFixed(2)} / 門 z=${blockedByGate.gateZ.toFixed(2)}`,
  );

  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/api/identity/reputation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'commission_completed', ref: `smoke-${i}`, note: 'smoke' }),
    });
    if (!res.ok) throw new Error(`reputation の記録に失敗: ${res.status}`);
  }
  await page.waitForFunction(() => window.__na_debug.gates().some((g) => g.open), null, { timeout: 8000 });
  const opened = await page.evaluate(() => ({
    gates: window.__na_debug.gates(),
    standing: window.__na_debug.standing(),
  }));
  check(opened.gates.some((g) => g.open), 'standing が上がると門が開く', `standing=${opened.standing}`);

  const passed = await page.evaluate(async () => {
    const hold = (codes, ms) =>
      new Promise((resolve) => {
        for (const code of codes) window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        setTimeout(() => {
          for (const code of codes) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
          resolve();
        }, ms);
      });
    const gate = window.__na_debug.gates().find((g) => g.open);
    window.__na_debug.moveTo(gate.x, gate.z + 3);
    await hold(['KeyW'], 1600);
    return { ...window.__na_debug.position(), gateZ: gate.z };
  });
  check(passed.z < passed.gateZ, '開いた門は通れる', `z=${passed.z.toFixed(2)} / 門 z=${passed.gateZ.toFixed(2)}`);

  // wallet を rotate しても評判は残り、門は開いたまま。
  const rotateRes = await fetch(`${BASE}/api/identity/rotate`, { method: 'POST' });
  if (!rotateRes.ok) throw new Error(`rotate に失敗: ${rotateRes.status}`);
  await sleep(1400);
  const afterRotate = await page.evaluate(() => ({
    gates: window.__na_debug.gates(),
    standing: window.__na_debug.standing(),
  }));
  check(
    afterRotate.gates.some((g) => g.open) && afterRotate.standing === opened.standing,
    'wallet を rotate しても評判と門の状態が続く',
    `standing=${afterRotate.standing}`,
  );

  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/m2-greybox.png' });
  console.log('screenshot: artifacts/m2-greybox.png');

  await browser.close();
} finally {
  stop();
}

if (failures.length > 0) {
  console.error(`\nsmoke 失敗: ${failures.length} 件`);
  process.exit(1);
}
console.log('\nsmoke 通過');
