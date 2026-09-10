import type { MarketItem, MarketItemState, MarketState } from '@na/shared';
import type { CommissionBoardPayload, SessionPayload, WorldPayload } from './api.js';
import type { StallObject } from './scene.js';

/**
 * HUD。固有名は world payload から引く（リテラルを持たない）。
 * inventory / credits / 接続エージェント数は M2 時点ではプレースホルダ値。仮値と分かる形で出す。
 */

/** 【仮値】inventory / credits / 接続エージェント数は未実装。M6・M7 で実データに差し替える。 */
export const PLACEHOLDER_HUD = {
  inventorySlots: 0,
  inventoryCapacity: 12,
  credits: 0,
  connectedAgents: 0,
} as const;

export interface HudHandles {
  update(input: {
    presentation: {
      mode: string;
      passes: string[];
      stats: { averageMs: number; budgetMs: number; exceeded: boolean };
      unconfirmed: string[];
      firstPass: boolean;
      assets: {
        on: boolean;
        meshes: number;
        placeholders: number;
        failures: number;
        environment: { present: boolean; on: boolean; triangles: number };
      };
      background: { enabled: boolean; on: boolean; placeholder: boolean };
    };
    world: WorldPayload;
    session: SessionPayload | null;
    board: CommissionBoardPayload | null;
    market: MarketState | null;
    focused: StallObject | null;
    fps: number;
    frameMs: number;
    stale: boolean;
  }): void;
}

export function createHud(root: HTMLElement, world: WorldPayload): HudHandles {
  root.innerHTML = `
    <section class="panel" id="panel-market">
      <h2>相場<span class="dim"> — server (M1)</span></h2>
      <table id="market-table"><tbody></tbody></table>
      <div class="row dim"><span id="market-tick"></span><span id="market-seed"></span></div>
    </section>
    <section class="panel" id="panel-board">
      <h2>commission board<span class="dim"> — 主モジュール</span></h2>
      <div id="board-body" class="dim">board 待ち</div>
    </section>
    <section class="panel" id="panel-focus"><h2>stall</h2><div id="focus-body" class="dim">通路を歩いて stall の前に立つ</div></section>
    <section class="panel" id="panel-hud">
      <h2>${escapeHtml(world.names.market.display)}<span class="dim"> / ${escapeHtml(world.names.district.display)}</span></h2>
      <div class="row"><span>inventory</span><span><span id="hud-inventory"></span> <span class="tag" id="hud-inventory-tag">mock</span></span></div>
      <div class="row"><span>credits</span><span><span id="hud-credits"></span> <span class="tag" id="hud-credits-tag">mock</span></span></div>
      <div class="row"><span>接続エージェント</span><span><span id="hud-agents"></span> <span class="tag">仮値</span></span></div>
    </section>
    <section class="panel" id="panel-identity">
      <h2>identity / standing<span class="dim"> — 円筒印章の履歴</span></h2>
      <div id="identity-body" class="dim">session 待ち</div>
    </section>
    <section class="panel" id="panel-stats">
      <div class="row"><span class="dim">fps</span><span id="stat-fps" class="num"></span></div>
      <div class="row"><span class="dim">frame</span><span id="stat-frame" class="num"></span></div>
      <div class="row"><span class="dim">render</span><span id="stat-mode"></span></div>
      <div class="row"><span class="dim">post</span><span id="stat-passes"></span></div>
      <div class="row"><span class="dim">assets</span><span id="stat-assets"></span></div>
      <div class="row"><span class="dim">背景</span><span id="stat-bg"></span></div>
      <div class="row"><span class="dim">budget</span><span id="stat-budget"></span></div>
      <div class="row"><span class="dim">未確定</span><span id="stat-unconfirmed"></span></div>
    </section>
    <div id="crosshair"></div>
  `;

  const el = (id: string): HTMLElement => {
    const node = root.querySelector<HTMLElement>(`#${id}`);
    if (!node) throw new Error(`HUD の要素が無い: ${id}`);
    return node;
  };

  const tbody = root.querySelector<HTMLElement>('#market-table tbody');
  if (!tbody) throw new Error('HUD の要素が無い: market-table');

  el('hud-inventory').textContent = '—';
  el('hud-credits').textContent = '—';
  el('hud-agents').textContent = String(PLACEHOLDER_HUD.connectedAgents);
  el('stat-unconfirmed').textContent = '計測中';

  return {
    update({ presentation, world: payload, session, board, market, focused, fps, frameMs, stale }) {
      el('stat-mode').innerHTML =
        `${escapeHtml(presentation.mode)} <span class="dim">(P で切替)</span>` +
        (presentation.firstPass ? ' <span class="tag">一次案</span>' : '');
      el('stat-passes').textContent = presentation.passes.length > 0 ? presentation.passes.join(',') : 'なし';
      const a = presentation.assets;
      const bg = presentation.background;
      el('stat-bg').innerHTML = !bg.enabled
        ? '<span class="dim">なし (B で切替)</span>'
        : `${bg.on ? 'splat' : 'off'} <span class="dim">(B)</span>` + (bg.placeholder ? ' <span class="tag">ダミー</span>' : '');
      el('stat-assets').innerHTML = a.environment.present
        ? `${a.environment.on ? 'ur.glb' : 'greybox'} <span class="dim">(M で切替)</span> ${a.environment.triangles}tri` +
          (a.failures > 0 ? ` <span class="down">失敗${a.failures}</span>` : '')
        : a.meshes === 0
          ? '<span class="dim">greybox のみ (M で切替)</span>'
          : `${a.on ? 'mesh' : 'greybox'} <span class="dim">(M)</span> ${a.meshes}` +
            (a.placeholders > 0 ? ' <span class="tag">ダミー</span>' : '') +
            (a.failures > 0 ? ` <span class="down">失敗${a.failures}</span>` : '');
      const stats = presentation.stats;
      el('stat-budget').innerHTML =
        stats.averageMs > 0
          ? `<span class="${stats.exceeded ? 'down' : 'dim'}">${stats.averageMs.toFixed(1)}/${stats.budgetMs}ms</span>`
          : `<span class="dim">計測中</span>`;
      el('stat-fps').textContent = fps.toFixed(0);
      el('stat-frame').textContent = `${frameMs.toFixed(1)}ms`;

      if (!market) {
        tbody.innerHTML = '<tr><td class="dim">サーバ待ち</td></tr>';
        el('market-tick').textContent = '';
        el('market-seed').textContent = '';
      } else {
        tbody.innerHTML = market.items
          .map((item) => renderRow(item, market.states.find((s) => s.itemId === item.id)))
          .join('');
        el('market-tick').textContent = `tick ${market.tick}${stale ? '（更新停止）' : ''}`;
        el('market-seed').textContent = `seed ${market.seed}`;
      }

      // inventory / credits は決済が settle まで通ったときの実値（mock 決済）。仮値ではない。
      if (session) {
        const ledger = session.ledger;
        el('hud-inventory').textContent = `${ledger.held}/${ledger.capacity}`;
        el('hud-credits').textContent = String(ledger.credits);
        // 単位が未確定なら credits タグに残す。
        el('hud-credits-tag').textContent = ledger.provisional ? 'mock/単位仮' : 'mock';
      }

      el('focus-body').innerHTML = renderFocus(payload, market, focused);
      el('identity-body').innerHTML = renderIdentity(session);
      el('board-body').innerHTML = renderBoard(board);
      el('stat-unconfirmed').textContent =
        `固有名 ${payload.unconfirmedNames.length} / 見た目 ${presentation.unconfirmed.length}`;
    },
  };
}

function renderRow(item: MarketItem, state: MarketItemState | undefined): string {
  if (!state) return `<tr><td>${escapeHtml(item.label_ja)}</td><td class="num dim">—</td></tr>`;
  const dir = item.direction === 'import' ? '輸入' : '輸出';
  const cls = state.priceDelta > 0 ? 'up' : state.priceDelta < 0 ? 'down' : 'dim';
  const arrow = state.priceDelta > 0 ? '▲' : state.priceDelta < 0 ? '▼' : '—';
  return `<tr>
    <td>${escapeHtml(item.label_ja)} <span class="dim">${dir}</span>${state.shock ? ' <span class="shock">!</span>' : ''}</td>
    <td class="num ${cls}">${state.price.toFixed(1)} ${arrow}</td>
    <td class="num dim">${Math.round(state.stock)}</td>
  </tr>`;
}

function renderFocus(world: WorldPayload, market: MarketState | null, focused: StallObject | null): string {
  if (!focused) return '<span class="dim">通路を歩いて stall の前に立つ</span>';
  const slot = focused.slot;
  const item = market?.items.find((i) => i.id === slot.categoryId);
  const state = market?.states.find((s) => s.itemId === slot.categoryId);
  const sources = slot.sources_ja.length > 0 ? slot.sources_ja.join(' / ') : '—';
  const stallName = world.names.stall.display;
  return `
    <div class="row"><span>${escapeHtml(slot.label_ja)}</span><span class="dim">${slot.direction === 'import' ? '輸入' : '輸出'}</span></div>
    <div class="row"><span class="dim">屋号</span><span>${escapeHtml(stallName)}</span></div>
    <div class="row"><span class="dim">産地</span><span>${escapeHtml(sources)}</span></div>
    <div class="row"><span class="dim">価格</span><span class="num">${state ? state.price.toFixed(2) : '—'}</span></div>
    <div class="row"><span class="dim">在庫</span><span class="num">${state ? Math.round(state.stock) : '—'}</span></div>
    <div class="row"><span class="dim">基準価格</span><span class="num">${item ? item.basePrice.toFixed(2) : '—'}</span></div>
    ${state?.shock ? `<div class="row shock"><span>供給ショック</span><span>x${state.shock.supplyMultiplier} (${state.shock.origin})</span></div>` : ''}
  `;
}

function renderBoard(board: CommissionBoardPayload | null): string {
  if (!board) return '<span class="dim">board 待ち</span>';
  const counts = new Map<string, number>();
  for (const commission of board.commissions) {
    counts.set(commission.state, (counts.get(commission.state) ?? 0) + 1);
  }
  const rows =
    counts.size === 0
      ? '<div class="row dim"><span>委託</span><span>まだ無い</span></div>'
      : [...counts.entries()]
          .map(([state, count]) => `<div class="row"><span class="dim">${escapeHtml(state)}</span><span>${count}</span></div>`)
          .join('');
  return `
    <div class="row"><span class="dim">主</span><span>${escapeHtml(board.modules.primary)}</span></div>
    <div class="row"><span class="dim">副</span><span>${escapeHtml(board.modules.secondary)}</span></div>
    ${rows}
    <div class="row"><span class="dim">flow</span><span>legs ${escapeHtml(board.flow.legs)} / unit ${escapeHtml(board.escrow.unit)} <span class="tag">未確定</span></span></div>
  `;
}

function renderIdentity(session: SessionPayload | null): string {
  if (!session) return '<span class="dim">session 待ち</span>';
  const { identity, wallet, standing, rooms } = session;
  const shortAddress = wallet ? `${wallet.address.slice(0, 14)}…` : '—';
  const roomRows = rooms
    .map(
      (room) => `<div class="row">
        <span class="dim">${escapeHtml(room.label_ja)}</span>
        <span class="${room.gate.allowed ? 'up' : 'down'}">${room.gate.allowed ? '開' : '閉'} <span class="dim">${room.gate.standing}/${room.gate.required}</span></span>
      </div>`,
    )
    .join('');
  return `
    <div class="row"><span class="dim">identity</span><span>${escapeHtml(identity.id)} <span class="dim">${identity.kind}</span></span></div>
    <div class="row"><span class="dim">wallet</span><span>${escapeHtml(shortAddress)} <span class="tag">未検証</span></span></div>
    <div class="row"><span class="dim">standing</span><span>${standing.score} <span class="dim">押印 ${standing.impressions.total}（+${standing.impressions.positive}/-${standing.impressions.negative}）</span></span></div>
    ${roomRows}
    <div class="row dim"><span>gate しきい値</span><span class="tag">仮値</span></div>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
