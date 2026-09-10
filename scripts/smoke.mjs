/**
 * M2 の受け入れを実環境で確認する。
 *  - サーバ（M1）を立て、ビルド済みクライアントを同一オリジンで配信
 *  - Chromium で開き、stall が config のカテゴリを反映しているか
 *  - 表示している市場値が M1 由来か（tick が進む）
 *  - 実際に歩けるか、フレーム予算に収まるか
 * 失敗したら非ゼロで落ちる（黙って通さない）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = process.env.NA_SMOKE_PORT ?? '8799';
const BASE = `http://127.0.0.1:${PORT}`;
// NA_WORLD_CONFIG が指定されていれば、サーバと期待値の双方でそれを使う（差し替えの確認用）。
const configPath = process.env.NA_WORLD_CONFIG
  ? new URL(process.env.NA_WORLD_CONFIG, `file://${process.cwd()}/`)
  : new URL('../world/world.config.json', import.meta.url);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
// room の定義も、world config と同じツリーから読む（config 差し替えの確認に使う）。
const treeRoot = new URL('./', configPath.href.replace(/world\/[^/]+$/, ''));
const roomsConfig = JSON.parse(readFileSync(new URL('config/rooms.config.json', treeRoot), 'utf8'));
const presentationConfig = JSON.parse(readFileSync(new URL('config/presentation.config.json', treeRoot), 'utf8'));
const passesFor = (mode) =>
  presentationConfig.postprocess.enabled && presentationConfig.postprocess.appliesTo.includes(mode)
    ? presentationConfig.postprocess.passes.filter((p) => p.enabled && p.strength > 0).map((p) => p.id)
    : [];
const expectedPasses = passesFor(presentationConfig.mode);
const gatedRooms = roomsConfig.rooms.filter((room) => room.minStanding > 0);
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

/**
 * フレーム予算は環境依存（headless の SwiftShader は実機より大幅に遅い）。
 * 既定では失敗として扱い、重いパス構成を意図的に入れる差し替え確認では advisory にする。
 * どちらでも実測値は必ず出す（隠さない）。
 */
const budgetAdvisoryEnv = process.env.NA_SMOKE_BUDGET_ADVISORY === '1';
/** ポスプロが掛かっている計測は advisory（実機計測は加藤さん段階）。素の経路は予算を守らせる。 */
const checkBudget = (ok, label, detail, passCount = 0) => {
  if (ok || (!budgetAdvisoryEnv && passCount === 0)) {
    check(ok, label, detail);
    return;
  }
  console.log(`warn ${label} — ${detail}（advisory: ポスプロ ${passCount} 枚の計測。実機計測は別途）`);
};

/** 計測値は必ず残す。 */
const measurements = [];

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
  const budgetNotices = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // 予算超過は専用の項目で扱う（ページエラーとは分ける）。
    if (msg.text().includes('フレーム予算を超えている')) {
      budgetNotices.push(msg.text());
      return;
    }
    pageErrors.push(msg.text());
  });

  // headless の描画は実機より遅いので、予算も headless 用の値を使う。
  await page.goto(`${BASE}/?headless=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__na_debug !== undefined, null, { timeout: 15000 });
  // これは M2/M3/M7（greybox）の受け入れ。環境メッシュ（ur.glb）は別 smoke で見せるので greybox で測る。
  await page.evaluate(() => window.__na_debug.setEnvironment?.(false));

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
  checkBudget(
    walk.frameMs < FRAME_BUDGET_MS,
    `フレーム予算内（< ${FRAME_BUDGET_MS}ms, headless SwiftShader）`,
    `${walk.frameMs.toFixed(1)}ms`,
    expectedPasses.length,
  );
  measurements.push({
    label: 'walk',
    mode: presentationConfig.mode,
    passes: expectedPasses,
    averageMs: Number(walk.frameMs.toFixed(2)),
    budgetMs: FRAME_BUDGET_MS,
  });

  check(pageErrors.length === 0, 'ページエラーが無い', pageErrors.join(' | '));

  const hudName = await page.locator('#panel-hud h2').innerText();
  const expectedName = config.naming.market.confirmed
    ? config.naming.market.value
    : `${config.naming.market.value}（未確定）`;
  check(hudName.includes(expectedName), 'HUD の市場名は config 由来（未確定はラベル付き）', hudName.replace(/\n/g, ' '));

  // 描画が健全なうちに確認用の画面を残す（通路の南端から市場全体）。
  await page.evaluate(() => window.__na_debug.moveTo(0, 11));
  await sleep(500);
  mkdirSync('artifacts', { recursive: true });
  const shotPath = process.env.NA_SMOKE_SHOT ?? 'artifacts/render-current.png';
  await page.screenshot({ path: shotPath });
  console.log(`screenshot: ${shotPath}（mode=${presentationConfig.mode}）`);

  // M7: commission board の一周（開設 → 両者合意 → escrow → レグ → 封印精算 → standing）。
  const post = async (body) => {
    const res = await fetch(`${BASE}/api/commission/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`commission action 失敗 (${body.action}): ${JSON.stringify(json)}`);
    return json;
  };

  const board0 = await (await fetch(`${BASE}/api/commission/board`)).json();
  check(
    board0.modules.primary === 'commission-board' && board0.modules.secondary === 'goods-storefront',
    '経済の重心は commission board（物販は副）',
    `flow=${board0.flow.legs}/${board0.flow.settlement_unit}（未確定）`,
  );

  const session0 = await (await fetch(`${BASE}/api/identity/session`)).json();
  const principalId = session0.identity.id;
  const agentRes = await fetch(`${BASE}/api/identity/agent`, { method: 'POST' });
  const { agent, standing: agentStanding0 } = await agentRes.json();
  const itemId = config.stall_categories.imports[0].id;
  const partnerId = config.trade_partners[0].id;

  const commission = await post({
    action: 'open',
    principalId,
    itemId,
    quantity: 2,
    amount: '10000',
    legs: [{ partnerId, note: '往路' }],
  });
  check(commission.state === 'open' && commission.provisional === true, '委託が出せる（条件は仮）', commission.id);

  await post({ action: 'propose', commissionId: commission.id, agentId: agent.id });
  const halfAgreed = await post({ action: 'agree', commissionId: commission.id, partyId: principalId });
  check(halfAgreed.state === 'open', '片方の合意では締結しない', `state=${halfAgreed.state}`);
  const agreed = await post({ action: 'agree', commissionId: commission.id, partyId: agent.id });
  check(agreed.state === 'agreed', '両者合意で締結する', `state=${agreed.state}`);

  const funded = await post({ action: 'fund', commissionId: commission.id });
  check(funded.state === 'funded', 'escrow を積める');

  const delivered = await post({ action: 'leg', commissionId: commission.id, index: 0, result: 'done' });
  check(delivered.state === 'delivered', 'レグの実行が納品まで進む');

  const settled = await post({ action: 'settle', commissionId: commission.id });
  const boardAfter = await (await fetch(`${BASE}/api/commission/board`)).json();
  const row = boardAfter.commissions.find((c) => c.id === commission.id);
  check(
    settled.state === 'settled' && row.escrow.state === 'released',
    '封印精算（payment_valid のみ）を通って escrow が release される',
  );

  const privacyAfter = await (await fetch(`${BASE}/api/privacy/status`)).json();
  check(privacyAfter.records >= 1, '精算が payment_valid だけの記録として残る', `records=${privacyAfter.records}`);

  const agentAfter = await (await fetch(`${BASE}/api/agent/status`)).json();
  check(
    agentAfter.gate.satisfied === false && agentAfter.gate.blockers.some((b) => b.id === 'cadence'),
    'エージェントの稼働前ゲートは未達のまま（schedule で回さない）',
    agentAfter.gate.blockers.map((b) => b.id).join(', '),
  );

  const adapters = await (await fetch(`${BASE}/api/adapters/status`)).json();
  check(
    adapters.adapters.length > 0 && adapters.adapters.every((a) => a.verified === false),
    '外部接続の口はすべて未検証（区分B）',
    adapters.adapters.map((a) => `${a.id}:${a.mode}`).join(', '),
  );

  const marketState = await (await fetch(`${BASE}/api/market/state`)).json();
  check(
    marketState.stalls.length > marketState.items.length && marketState.stalls.every((s) => s.provisional === true),
    '1 カテゴリを複数の stall が分け持つ（分布は仮値）',
    `${marketState.stalls.length} 軒 / ${marketState.items.length} 品目`,
  );

  const storefront = await (await fetch(`${BASE}/api/storefront/listing`)).json();
  check(
    storefront.rank === 'secondary' && storefront.subordinateTo === 'commission-board',
    '物販は副モジュールとして分離されている',
    `${storefront.items.length} 品目`,
  );

  void agentStanding0;

  mkdirSync('artifacts', { recursive: true });
  // 確認用に通路の南端から市場全体を撮る。
  await page.evaluate(() => window.__na_debug.moveTo(0, 11));
  await sleep(400);
  // M3: standing が room gate に効く（mock で一周）。
  const gatesBefore = await page.evaluate(() => window.__na_debug.gates());
  check(
    gatesBefore.length === gatedRooms.length &&
      gatesBefore.every((g) => gatedRooms.some((r) => r.id === g.roomId && r.minStanding === g.required)),
    '門は config の room 定義を反映する',
    gatesBefore.map((g) => `${g.roomId}>=${g.required}`).join(', '),
  );
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

  // しきい値は config 由来なので、開くまで押印を積む（回数を決め打ちしない）。
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${BASE}/api/identity/reputation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'commission_completed', ref: `smoke-${i}`, note: 'smoke' }),
    });
    if (!res.ok) throw new Error(`reputation の記録に失敗: ${res.status}`);
    const session = await (await fetch(`${BASE}/api/identity/session`)).json();
    if (session.rooms.some((room) => room.gate.allowed && room.gate.required > 0)) break;
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

  // 見た目の層: config どおりのモードとパス構成で立ち上がる。
  const renderState = await page.evaluate(() => ({
    mode: window.__na_debug.renderMode(),
    passes: window.__na_debug.postPasses(),
    unconfirmed: window.__na_debug.unconfirmedPresentation(),
  }));
  check(
    renderState.mode === presentationConfig.mode,
    'レンダのモードは presentation config 由来',
    `${renderState.mode}`,
  );
  check(
    JSON.stringify(renderState.passes) === JSON.stringify(expectedPasses),
    'ポスプロのパス構成は presentation config 由来',
    renderState.passes.join(',') || 'なし',
  );
  check(renderState.unconfirmed.length > 0, '見た目は未確定のまま動いている', renderState.unconfirmed.join(', '));

  // greybox ↔ stylized のトグル。両方の経路で描けること。
  const measure = async (mode) => {
    await page.evaluate((m) => window.__na_debug.setRenderMode(m), mode);
    // 切り替え直後は平均が 0 に戻る。新しい平均が出るまで待つ。
    await page.waitForFunction(() => window.__na_debug.frameStats().averageMs > 0, null, { timeout: 30000 });
    return page.evaluate(() => ({
      mode: window.__na_debug.renderMode(),
      stats: window.__na_debug.frameStats(),
    }));
  };
  const stylized = await measure('stylized');
  check(stylized.mode === 'stylized', 'stylized 経路に切り替わる');
  const stylizedPasses = await page.evaluate(() => window.__na_debug.postPasses());
  check(
    JSON.stringify(stylizedPasses) === JSON.stringify(passesFor('stylized')),
    'stylized で掛かるパスは config の appliesTo どおり',
    stylizedPasses.join(',') || 'なし',
  );
  checkBudget(
    stylized.stats.averageMs > 0 && !stylized.stats.exceeded,
    `stylized のフレーム予算内（< ${stylized.stats.budgetMs}ms, headless）`,
    `${stylized.stats.averageMs.toFixed(1)}ms`,
    stylizedPasses.length,
  );
  measurements.push({
    label: 'stylized',
    mode: 'stylized',
    passes: stylizedPasses,
    averageMs: Number(stylized.stats.averageMs.toFixed(2)),
    budgetMs: stylized.stats.budgetMs,
  });

  const backToGreybox = await measure('greybox');
  check(backToGreybox.mode === 'greybox', 'greybox 経路に戻せる（greybox は消さない）');
  const greyboxPasses = await page.evaluate(() => window.__na_debug.postPasses());
  check(
    JSON.stringify(greyboxPasses) === JSON.stringify(passesFor('greybox')),
    'greybox 経路は config どおり素のまま残る',
    greyboxPasses.join(',') || 'なし',
  );
  checkBudget(
    backToGreybox.stats.averageMs > 0 && !backToGreybox.stats.exceeded,
    `greybox のフレーム予算内（< ${backToGreybox.stats.budgetMs}ms, headless）`,
    `${backToGreybox.stats.averageMs.toFixed(1)}ms`,
    greyboxPasses.length,
  );
  // トグルの A/B を画像でも残す（stylized と同じ立ち位置から撮る）。
  await page.evaluate(() => window.__na_debug.moveTo(0, 11));
  await sleep(500);
  await page.screenshot({ path: process.env.NA_SMOKE_GREYBOX_SHOT ?? 'artifacts/greybox-compare.png' });

  measurements.push({
    label: 'greybox',
    mode: 'greybox',
    passes: greyboxPasses,
    averageMs: Number(backToGreybox.stats.averageMs.toFixed(2)),
    budgetMs: backToGreybox.stats.budgetMs,
  });
  if (budgetNotices.length > 0) {
    console.log(`note 予算超過の通知（画面にも出ている）: ${budgetNotices.length} 件`);
    for (const notice of budgetNotices) console.log(`     ${notice}`);
  }

  // 生成アセット（NA_SMOKE_ASSETS=1 のときだけ）。
  if (process.env.NA_SMOKE_ASSETS === '1') {
    const meshReport = await page.evaluate(() => window.__na_debug.meshReport());
    const failures = await page.evaluate(() => window.__na_debug.meshFailures());
    check(failures.length === 0, '割り当てた .glb がすべて読める', failures.map((f) => `${f.slot}:${f.error}`).join(' | '));
    check(meshReport.length > 0, '生成メッシュがスロットに入る', `${meshReport.length} スロット`);
    check(
      meshReport.every((m) => m.reducedTriangles <= 40000),
      '生成メッシュがポリゴン予算内（decimation 後）',
      meshReport.map((m) => `${m.slot}:${m.reducedTriangles}`).join(', '),
    );
    check(
      meshReport.every((m) => m.placeholder === true),
      'ダミーはダミーとして扱う（placeholder フラグ）',
      `placeholder ${meshReport.filter((m) => m.placeholder).length}/${meshReport.length}`,
    );

    // 生成メッシュ ON で立ち上がっている → greybox へ戻せる → また生成へ。
    await page.evaluate(() => window.__na_debug.setAssets(true));
    await sleep(200);
    check((await page.evaluate(() => window.__na_debug.assetsEnabled())) === true, '生成メッシュに切り替わる');
    await page.evaluate(() => window.__na_debug.moveTo(0, 11));
    await sleep(300);
    await page.screenshot({ path: process.env.NA_SMOKE_MESH_SHOT ?? 'artifacts/assets-mesh.png' });
    await page.evaluate(() => window.__na_debug.setAssets(false));
    await sleep(200);
    check((await page.evaluate(() => window.__na_debug.assetsEnabled())) === false, 'greybox の箱に戻せる（greybox は消さない）');
    await page.evaluate(() => window.__na_debug.setAssets(true));
  }

  // 背景 splat レイヤー（NA_SMOKE_BG=1 のときだけ）。
  if (process.env.NA_SMOKE_BG === '1') {
    const status = await page.evaluate(() => window.__na_debug.backgroundStatus());
    check(status.loaded === true, '背景 splat が読める', status.error ?? 'ok');
    check(status.placeholder === true, 'ダミー splat はダミーとして扱う（placeholder）');
    check(
      (await page.evaluate(() => window.__na_debug.backgroundEnabled())) === true,
      '背景 splat が前景の奥に立つ',
    );
    // 前景の当たりに背景 collider が入る／入らない（collider 無しなら 0）。
    check(typeof status.colliderBoxes === 'number', 'collider は splat と分けて扱う', `collider ${status.colliderBoxes} 箱`);
    // トグル: 背景 off → 前景だけ、また on。
    await page.evaluate(() => window.__na_debug.setBackground(false));
    await sleep(150);
    check((await page.evaluate(() => window.__na_debug.backgroundEnabled())) === false, '背景を切ると前景だけで動く');
    await page.evaluate(() => window.__na_debug.setBackground(true));
    await sleep(150);
    await page.evaluate(() => window.__na_debug.moveTo(0, 12));
    await sleep(300);
    await page.screenshot({ path: process.env.NA_SMOKE_BG_SHOT ?? 'artifacts/background-splat.png' });
  }

  check(
    (await page.evaluate(() => window.__na_debug.contextLost())) === false,
    'WebGL コンテキストが生きている',
  );

  // フレーム予算の実測を残す（headless の SwiftShader での値。実機とは別物）。
  mkdirSync('artifacts', { recursive: true });
  const budgetPath = process.env.NA_SMOKE_BUDGET_OUT ?? 'artifacts/frame-budget.json';
  writeFileSync(
    budgetPath,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        environment: 'headless chromium (SwiftShader)',
        note: '実機計測ではない。パス枚数と強度のトレードオフを見るための実測値',
        tuning: presentationConfig.tuning ?? null,
        measurements,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`frame budget: ${budgetPath}`);
  for (const m of measurements) {
    console.log(`     ${m.label}: ${m.averageMs}ms / 予算 ${m.budgetMs}ms / passes ${m.passes.join(',') || 'なし'}`);
  }

  await browser.close();
} finally {
  stop();
}

if (failures.length > 0) {
  console.error(`\nsmoke 失敗: ${failures.length} 件`);
  process.exit(1);
}
console.log('\nsmoke 通過');
