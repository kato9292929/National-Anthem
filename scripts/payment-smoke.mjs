/**
 * 決済デモ（区分A・mock）の受け入れを実環境で確認し、録画（フレーム列）を残す。
 *  - サーバ（NA_X402_MOCK=1）を立て、ビルド済みクライアントを同一オリジンで配信
 *  - Chromium で「近づく → 買う → 決済フロー → 反映」を 1 本走らせる
 *  - 決済の各段（402 → 署名 → payment_valid → 清算）が実イベントとして点灯するか
 *  - 成功時に在庫・credits・standing が動くか（HUD の実値）
 *  - 異常系（検証失敗）が握りつぶされず失敗として出るか、状態が動かないか
 *  - エージェント版が同じフローで走るか（第2ビート）
 * 失敗したら非ゼロで落ちる。フレーム列・要約 JSON を artifacts/ に出す。ソース修正ゼロで再実行できる。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = process.env.NA_SMOKE_PORT ?? '8801';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'artifacts';

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const server = spawn(process.execPath, ['packages/server/dist/index.js'], {
  env: {
    ...process.env,
    NA_MARKET_SEED: 'na-pay-smoke-0001',
    NA_SERVER_PORT: PORT,
    NA_SERVE_CLIENT: '1',
    // 区分A の mock 決済一周を有効にする（鍵・外部到達は不要）。
    NA_X402_MOCK: '1',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

const frames = [];
const shot = async (page, name) => {
  mkdirSync(OUT, { recursive: true });
  const path = `${OUT}/${name}`;
  await page.screenshot({ path });
  frames.push(name);
};

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

  // 決済デモが有効か（mock 一周が配信されるか）。
  const presentation0 = await (await fetch(`${BASE}/api/presentation/config`)).json();
  void presentation0;

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
  // 録画で段が見えるよう、点灯の間隔を少し取る（各段の合否は実データ）。
  await page.evaluate(() => window.__na_debug.setStepDelay(260));

  // 1. stall の前に立つ。
  const focusedId = await page.evaluate(async () => {
    const stall = window.__na_debug.stallPositions[0];
    window.__na_debug.moveTo(stall.x < 0 ? stall.x + 2.6 : stall.x - 2.6, stall.z);
    await new Promise((r) => setTimeout(r, 150));
    return window.__na_debug.focusedCategoryId();
  });
  check(focusedId !== null, '購入対象の stall の前に立てる', `focus=${focusedId ?? 'なし'}`);
  await shot(page, 'payment-01-approach.png');

  // 2. E で購入 UI を開く（近づいて買う導線）。
  const buyVisible = await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' }));
    const box = document.querySelector('#buy');
    return box ? !box.hidden : false;
  });
  check(buyVisible, 'stall の前で E を押すと購入 UI が出る');
  await shot(page, 'payment-02-buy.png');

  const ledgerBefore = await page.evaluate(() => window.__na_debug.ledger());
  const standingBefore = await page.evaluate(() => window.__na_debug.standing());

  // 3. 決済フローを走らせ、進む様子をフレーム列で残す。
  await page.evaluate(() => {
    // 開いている購入 UI は checkout 側で閉じる。Enter 相当を debug 経由で確定。
    window.__pay = { done: false, ok: null };
    window.__na_debug.checkout().then(
      (ok) => {
        window.__pay = { done: true, ok };
      },
      (error) => {
        window.__pay = { done: true, ok: false, error: String(error) };
      },
    );
  });
  let flowFrames = 0;
  for (let i = 0; i < 12; i++) {
    const state = await page.evaluate(() => ({
      flow: window.__na_debug.paymentFlow(),
      steps: window.__na_debug.paymentSteps(),
      done: window.__pay.done,
    }));
    await shot(page, `payment-03-flow-${String(i).padStart(2, '0')}.png`);
    flowFrames += 1;
    if (state.done && (state.flow === 'ok' || state.flow === 'fail')) break;
    await sleep(220);
  }
  // reveal 完了まで待つ。
  await page.waitForFunction(() => window.__pay.done && window.__na_debug.paymentFlow() !== 'running', null, {
    timeout: 15000,
  });
  const afterBuy = await page.evaluate(() => ({
    ok: window.__pay.ok,
    flow: window.__na_debug.paymentFlow(),
    steps: window.__na_debug.paymentSteps(),
    ledger: window.__na_debug.ledger(),
    standing: window.__na_debug.standing(),
  }));
  await shot(page, 'payment-04-settled.png');

  check(afterBuy.ok === true && afterBuy.flow === 'ok', '決済フローが清算まで通る（mock）', `flow=${afterBuy.flow}`);
  check(
    afterBuy.steps.every((s) => s.state === 'ok'),
    '4 段すべてが点灯する（402 → 署名 → payment_valid → 清算）',
    afterBuy.steps.map((s) => `${s.step}:${s.state}`).join(', '),
  );
  check(
    afterBuy.ledger.credits < ledgerBefore.credits,
    '成功で credits が減る（実値・HUD 反映）',
    `${ledgerBefore.credits} -> ${afterBuy.ledger.credits}`,
  );
  check(afterBuy.ledger.held > ledgerBefore.held, '成功で在庫が増える', `held ${ledgerBefore.held} -> ${afterBuy.ledger.held}`);
  check(
    afterBuy.standing !== null && standingBefore !== null && afterBuy.standing > standingBefore,
    '成功で購入者の standing が上がる',
    `${standingBefore} -> ${afterBuy.standing}`,
  );

  // 4. 異常系: 検証失敗は握りつぶさず失敗として出す。状態は動かさない。
  const ledgerPreFail = await page.evaluate(() => window.__na_debug.ledger());
  await page.evaluate(() => {
    window.__pay = { done: false, ok: null };
    window.__na_debug.checkout({ simulateFailure: 'verify' }).then(
      (ok) => {
        window.__pay = { done: true, ok };
      },
      (error) => {
        window.__pay = { done: true, ok: false, error: String(error) };
      },
    );
  });
  await page.waitForFunction(() => window.__pay.done && window.__na_debug.paymentFlow() !== 'running', null, {
    timeout: 15000,
  });
  await sleep(300);
  const afterFail = await page.evaluate(() => ({
    flow: window.__na_debug.paymentFlow(),
    steps: window.__na_debug.paymentSteps(),
    ledger: window.__na_debug.ledger(),
  }));
  await shot(page, 'payment-05-failed.png');
  check(afterFail.flow === 'fail', '検証失敗は失敗として画面に出る（成功に見せない）', `flow=${afterFail.flow}`);
  check(
    afterFail.steps.find((s) => s.step === 'settled')?.state !== 'ok',
    '検証失敗では清算段が点灯しない',
    afterFail.steps.map((s) => `${s.step}:${s.state}`).join(', '),
  );
  check(
    afterFail.ledger.credits === ledgerPreFail.credits && afterFail.ledger.held === ledgerPreFail.held,
    '失敗では手持ちが動かない',
    `credits ${ledgerPreFail.credits} -> ${afterFail.ledger.credits}`,
  );

  // 5. エージェント版（第2ビート）: 同じ決済フローが走る。
  await page.evaluate(() => {
    window.__pay = { done: false, ok: null };
    window.__na_debug.agentCheckout().then(
      (ok) => {
        window.__pay = { done: true, ok };
      },
      (error) => {
        window.__pay = { done: true, ok: false, error: String(error) };
      },
    );
  });
  await page.waitForFunction(() => window.__pay.done && window.__na_debug.paymentFlow() !== 'running', null, {
    timeout: 15000,
  });
  await sleep(300);
  const afterAgent = await page.evaluate(() => ({
    ok: window.__pay.ok,
    flow: window.__na_debug.paymentFlow(),
    buyer: document.querySelector('#pay-buyer')?.textContent ?? '',
  }));
  await shot(page, 'payment-06-agent.png');
  check(afterAgent.ok === true && afterAgent.flow === 'ok', 'エージェントも同じ決済フローで買える（第2ビート）', afterAgent.buyer);
  check(afterAgent.buyer.includes('エージェント'), '決済フローが買い手（エージェント）を示す', afterAgent.buyer);

  // 6. mock であることの常時表示。
  const bannerVisible = await page.evaluate(() => {
    const b = document.querySelector('#mock-banner');
    return b ? b.textContent : null;
  });
  check(
    typeof bannerVisible === 'string' && bannerVisible.includes('mock'),
    'mock settlement の表示が常に出ている（実チェーンではない）',
    bannerVisible ?? 'なし',
  );

  check(pageErrors.length === 0, 'ページエラーが無い', pageErrors.join(' | '));

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/payment-smoke.json`,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: 'headless chromium (SwiftShader) / NA_X402_MOCK=1',
        note: 'すべて mock 決済（区分A）。実チェーン着金は対象外。tx は mock: 前置き。',
        frames,
        success: {
          steps: afterBuy.steps,
          creditsFrom: ledgerBefore.credits,
          creditsTo: afterBuy.ledger.credits,
          heldFrom: ledgerBefore.held,
          heldTo: afterBuy.ledger.held,
          standingFrom: standingBefore,
          standingTo: afterBuy.standing,
        },
        failure: { flow: afterFail.flow, steps: afterFail.steps },
        agent: { ok: afterAgent.ok, buyer: afterAgent.buyer },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`frames: ${frames.length} 枚 -> ${OUT}/ / 要約 ${OUT}/payment-smoke.json`);
  void flowFrames;

  await browser.close();
} finally {
  stop();
}

if (failures.length > 0) {
  console.error(`\n決済スモーク 失敗: ${failures.length} 件`);
  process.exit(1);
}
console.log('\n決済スモーク 通過');
