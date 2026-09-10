/**
 * 白飛びの切り分け（診断ファースト・区分A）。決済は触らない。見た目とカメラのみ。
 * ur.glb を固定の street 構図で、unlit on/off × render stylized/greybox で 1 枚ずつ撮り、
 * fit 後 bbox・カメラ座標もログに出す。基準画像との読みの比較用。artifacts/diag-*.png。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = '8812';
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['packages/server/dist/index.js'], {
  env: { ...process.env, NA_MARKET_SEED: 'diag', NA_SERVER_PORT: PORT, NA_SERVE_CLIENT: '1', NA_X402_MOCK: '1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
process.on('exit', () => server.kill('SIGTERM'));
for (let i = 0; ; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
  if (i > 100) throw new Error('no server'); await sleep(100);
}
const exe = ['/opt/pw-browsers/chromium/chrome-linux/chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(`${BASE}/?headless=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__na_debug !== undefined, null, { timeout: 15000 });
await page.waitForFunction(() => window.__na_debug.environmentStatus().loaded === true, null, { timeout: 10000 });
// HUD を隠して素の viewport を撮る。
await page.evaluate(() => { const h = document.querySelector('#hud'); if (h) h.style.display = 'none'; const p = document.querySelector('#prompt'); if (p) p.style.display = 'none'; const b = document.querySelector('#mock-banner'); if (b) b.style.display = 'none'; });

const status = await page.evaluate(() => window.__na_debug.environmentStatus());
console.log('ENV BBOX', JSON.stringify(status.box));
console.log('ENV unlit(default)', status.unlit, 'tri', status.triangles);

// 固定の street 構図: 通路南端からジッグラト（奥・-Z）を正面に。
const CAM = { x: 0, z: 10, yaw: 0, pitch: 4 };
mkdirSync('artifacts', { recursive: true });

const shoot = async (name, { unlit, render }) => {
  await page.evaluate(() => window.__na_debug.setEnvironment(true));
  await page.evaluate((u) => window.__na_debug.setEnvUnlit(u), unlit);
  await page.evaluate((m) => window.__na_debug.setRenderMode(m), render);
  await page.evaluate((c) => window.__na_debug.setView(c.x, c.z, c.yaw, c.pitch), CAM);
  await sleep(500);
  const cam = await page.evaluate(() => window.__na_debug.position());
  await page.screenshot({ path: `artifacts/${name}` });
  console.log(`shot ${name} — unlit=${unlit} render=${render} cam=(${cam.x.toFixed(1)},${cam.z.toFixed(1)})`);
};

await shoot('diag-A-unlit-stylized.png', { unlit: true, render: 'stylized' });
await shoot('diag-B-lit-stylized.png', { unlit: false, render: 'stylized' });
await shoot('diag-C-lit-greybox.png', { unlit: false, render: 'greybox' });
await shoot('diag-D-unlit-greybox.png', { unlit: true, render: 'greybox' });

await browser.close();
server.kill('SIGTERM');
console.log('done');
