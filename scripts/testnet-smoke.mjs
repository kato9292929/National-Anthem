/**
 * Base Sepolia（testnet）で実決済を 1 件通す（区分B・加藤さん環境）。
 *
 * 前提（実環境で用意）:
 *   NA_X402_TESTNET=1 / NA_X402_PAYWALL=1 / NA_X402_RAIL=base-sepolia
 *   NA_X402_FACILITATOR_URL=<testnet facilitator> / NA_EVM_PRIVATE_KEY=<testnet 鍵>
 *   NA_BASE_SEPOLIA_RPC_URL=<RPC> / config の base-sepolia rail に payTo を入れて confirmed:true
 *   faucet で testnet USDC/gas を wallet に入れておく。egress allowlist に facilitator と RPC を追加。
 *
 * これは実チェーンに tx を出す。人間の購入 1 件が実 settle し、実 tx hash が画面と結果に残ることを、
 * 自己申告ではなく tx hash で確認する。破綻（偽 tx・偽着金・握りつぶし）はしない。
 *   docs/testnet-base-sepolia-runbook.md 参照。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = process.env.NA_SMOKE_PORT ?? '8802';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'artifacts';
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

// 実環境の env をそのまま渡す（testnet の鍵・facilitator・RPC は加藤さんが設定）。
const server = spawn(process.execPath, ['packages/server/dist/index.js'], {
  env: {
    ...process.env,
    NA_MARKET_SEED: process.env.NA_MARKET_SEED ?? 'na-testnet-0001',
    NA_SERVER_PORT: PORT,
    NA_SERVE_CLIENT: '1',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
process.on('exit', () => server.kill('SIGTERM'));

const frames = [];
const shot = async (page, name) => {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}` });
  frames.push(name);
};

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* 起動待ち */
    }
    if (i > 100) throw new Error('サーバが起動しない');
    await sleep(100);
  }

  const status = await (await fetch(`${BASE}/api/checkout/status`)).json();
  check(status.mode === 'testnet', '決済モードが testnet（Base Sepolia）である', `mode=${status.mode} rail=${status.rail}`);
  if (status.mode !== 'testnet') {
    throw new Error(
      'testnet モードで起動していない。NA_X402_TESTNET=1 / NA_X402_PAYWALL=1 / NA_X402_RAIL=base-sepolia ' +
        'と実 facilitator・EVM 鍵・確定した base-sepolia rail を設定する（runbook 参照）',
    );
  }
  check(status.testnet === true && /84532/.test(status.network ?? ''), 'network が Base Sepolia（84532）', status.network ?? '');

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
    if (msg.type() === 'error' && !msg.text().includes('フレーム予算を超えている')) pageErrors.push(msg.text());
  });

  await page.goto(`${BASE}/?headless=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__na_debug !== undefined, null, { timeout: 15000 });
  await page.waitForFunction(() => window.__na_debug.ledger() !== null, null, { timeout: 10000 });
  await page.evaluate(() => window.__na_debug.setStepDelay(260));

  // 1. stall の前に立つ。
  await page.evaluate(async () => {
    const stalls = window.__na_debug.stallPositions;
    const south = stalls.reduce((a, b) => (b.z > a.z ? b : a));
    window.__na_debug.moveTo(south.x < 0 ? south.x + 2.6 : south.x - 2.6, south.z + 3);
    await new Promise((r) => setTimeout(r, 150));
  });
  await shot(page, 'testnet-01-approach.png');

  // 2. 実決済（人間の購入 1 件）。実チェーンに tx を出す。時間がかかるので待つ。
  await page.evaluate(() => {
    window.__pay = { done: false, ok: null, error: null };
    window.__na_debug.checkout().then(
      (ok) => {
        window.__pay = { done: true, ok, error: null };
      },
      (error) => {
        window.__pay = { done: true, ok: false, error: String(error) };
      },
    );
  });
  for (let i = 0; i < 40; i++) {
    const done = await page.evaluate(() => window.__pay.done);
    await shot(page, `testnet-02-flow-${String(i).padStart(2, '0')}.png`);
    if (done) break;
    await sleep(1500);
  }
  await page.waitForFunction(() => window.__pay.done, null, { timeout: 120000 });
  const result = await page.evaluate(() => ({
    ok: window.__pay.ok,
    error: window.__pay.error,
    flow: window.__na_debug.paymentFlow(),
    steps: window.__na_debug.paymentSteps(),
  }));
  await shot(page, 'testnet-03-settled.png');

  // 3. 実 tx hash を確認（自己申告でなく hash で）。二重購入しないよう追加の決済はしない。
  check(result.ok === true && result.flow === 'ok', '実 testnet で決済が settle する', `flow=${result.flow}${result.error ? ` / ${result.error}` : ''}`);
  check(
    result.steps.every((s) => s.state === 'ok'),
    '4 段すべてが点灯する（402 → 実署名 → payment_valid → 実清算）',
    result.steps.map((s) => `${s.step}:${s.state}`).join(', '),
  );

  // 画面の settled 行 / status から実 tx hash を取り、形を確かめる。
  const txText = await page.evaluate(() => document.querySelector('#pay-status')?.textContent ?? '');
  const settledDetail = await page.evaluate(
    () => document.querySelector('[data-detail="settled"]')?.textContent ?? '',
  );
  const txMatch = (settledDetail + ' ' + txText).match(/0x[0-9a-fA-F]{64}/);
  const txHash = txMatch ? txMatch[0] : '';
  check(TX_RE.test(txHash), '実 tx hash が画面に出る（mock: を付けない実物）', txHash || settledDetail);

  check(pageErrors.length === 0, 'ページエラーが無い', pageErrors.join(' | '));

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/testnet-payment.json`,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        network: status.network,
        rail: status.rail,
        explorer: status.explorer,
        txHash,
        txUrl: status.explorer && txHash ? `${status.explorer}${txHash}` : null,
        steps: result.steps,
        frames,
        note: 'Base Sepolia testnet の実 settle。実弾ではない（faucet の testnet USDC）。verify:b で receipt を確認し証拠に記録する。',
      },
      null,
      2,
    )}\n`,
  );
  console.log('');
  console.log(`実 tx: ${txHash || '(取得できず)'}`);
  if (status.explorer && txHash) console.log(`explorer: ${status.explorer}${txHash}`);
  console.log(`frames: ${frames.length} 枚 -> ${OUT}/ / 要約 ${OUT}/testnet-payment.json`);
  console.log('次: NA_VERIFY_BASE_SEPOLIA_TX=<上の tx> で npm run verify:b を回し、証拠を記録して rail を verified:true にする');

  await browser.close();
} finally {
  server.kill('SIGTERM');
}

if (failures.length > 0) {
  console.error(`\ntestnet スモーク 失敗: ${failures.length} 件`);
  process.exit(1);
}
console.log('\ntestnet スモーク 通過');
