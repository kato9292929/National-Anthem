import type { CheckoutResultPayload, CheckoutStepPayload, CheckoutStatusPayload } from './api.js';

/**
 * 決済フローの可視化（この画面の主役）と、購入インタラクションの最小 UI。
 *
 * - 4 段（402 受信 → 支払い送信 → payment_valid → 清算）を順に点灯させる。
 * - 各段はバックエンドの実イベントに紐づく。UI だけで成功を先に描かない。
 * - 段の点灯は少しずつ送らせて「進む様子」を見せる（reveal 演出）。ただし各段の
 *   合否・値は実データそのもの。演出だけの偽ステップは作らない。
 * - すべて mock。画面には常に「mock settlement / 実チェーンではない」を出す。tx は mock:。
 */

export interface BuyTarget {
  itemId: string;
  label: string;
  unitPrice: number;
  quantity: number;
  amount: number;
}

type StepId = 'challenge' | 'signed' | 'verified' | 'settled';
type RowState = 'pending' | 'active' | 'ok' | 'fail';

const STEP_ROWS: { id: StepId; label: string }[] = [
  { id: 'challenge', label: '402 受信（価格提示）' },
  { id: 'signed', label: '支払い送信（mock 署名）' },
  { id: 'verified', label: 'payment_valid（封印検証）' },
  { id: 'settled', label: '清算（mock 着金）' },
];

export interface PaymentUi {
  /** 決済モードを反映する（banner・見出し・段ラベル・tx 表示を mock/testnet で切り替える）。 */
  setMode(status: CheckoutStatusPayload): void;
  isBuyOpen(): boolean;
  isRunning(): boolean;
  buyTarget(): BuyTarget | null;
  openBuy(target: BuyTarget): void;
  closeBuy(): void;
  /** 決済フローを開始する（パネルを初期化して running にする）。 */
  begin(target: BuyTarget, buyerKind: 'human' | 'agent'): void;
  /** 実イベントを 1 段受け取る（少し遅らせて点灯する）。 */
  pushStep(step: CheckoutStepPayload): void;
  /** 結果を反映して running を終える。reveal 完了まで待てるよう Promise を返す。 */
  finish(result: CheckoutResultPayload): Promise<void>;
  /** 事前確認・ストリームの失敗を画面に出す（成功に見せない）。 */
  fail(message: string): void;
  /** スモーク用: 現在の各段の点灯状態。 */
  stepStates(): { step: StepId; state: RowState }[];
  flowState(): 'idle' | 'running' | 'ok' | 'fail';
  /** reveal の待ち時間（ms）。0 で即時（テスト用）。 */
  setStepDelay(ms: number): void;
}

export function createPaymentUi(root: HTMLElement): PaymentUi {
  root.insertAdjacentHTML(
    'beforeend',
    `
    <div id="mock-banner">mock settlement — 実チェーンではない（区分A・鍵/外部到達なし）</div>
    <section class="panel" id="panel-payment">
      <h2>x402 決済フロー<span class="dim" id="pay-mode"> — mock</span> <span id="pay-buyer" class="tag"></span></h2>
      <div id="pay-rows">
        ${STEP_ROWS.map(
          (r) => `
        <div class="pay-row" data-step="${r.id}">
          <span class="pay-dot" data-state="pending"></span>
          <span class="pay-label">${r.label}</span>
          <span class="pay-detail dim" data-detail="${r.id}"></span>
        </div>`,
        ).join('')}
      </div>
      <div id="pay-status" class="dim">stall の前で E → Enter で購入（mock 決済）</div>
    </section>
    <div id="buy" hidden>
      <div class="buy-card">
        <div class="buy-title">購入</div>
        <div class="row"><span id="buy-label"></span><span id="buy-amount" class="num"></span></div>
        <div class="row dim"><span>単価</span><span id="buy-unit" class="num"></span></div>
        <div class="row dim"><span>決済</span><span>x402 exact / mock</span></div>
        <div class="buy-actions dim">Enter で決済 / Q で取消</div>
      </div>
    </div>
  `,
  );

  const el = (id: string): HTMLElement => {
    const node = root.querySelector<HTMLElement>(`#${id}`);
    if (!node) throw new Error(`payment UI の要素が無い: ${id}`);
    return node;
  };
  const buyBox = el('buy');
  const rowFor = (step: StepId): HTMLElement => {
    const node = root.querySelector<HTMLElement>(`.pay-row[data-step="${step}"]`);
    if (!node) throw new Error(`pay-row が無い: ${step}`);
    return node;
  };
  const setRowState = (step: StepId, state: RowState): void => {
    const dot = rowFor(step).querySelector<HTMLElement>('.pay-dot');
    if (dot) dot.dataset['state'] = state;
  };
  const setRowDetail = (step: StepId, text: string): void => {
    const detail = root.querySelector<HTMLElement>(`[data-detail="${step}"]`);
    if (detail) detail.textContent = text;
  };
  const setRowLabel = (step: StepId, text: string): void => {
    const label = rowFor(step).querySelector<HTMLElement>('.pay-label');
    if (label) label.textContent = text;
  };

  let buyOpen = false;
  let target: BuyTarget | null = null;
  let running = false;
  let flow: 'idle' | 'running' | 'ok' | 'fail' = 'idle';
  let stepDelay = 240;
  let mode: 'mock' | 'testnet' | 'disabled' = 'mock';
  let explorerBase: string | null = null;

  // reveal キュー: 実イベントを少しずつ点灯させる（各段の合否は実データ）。
  const queue: CheckoutStepPayload[] = [];
  let revealing = false;

  const resetRows = (): void => {
    for (const r of STEP_ROWS) {
      setRowState(r.id, 'pending');
      setRowDetail(r.id, '');
    }
  };

  const applyStep = (step: CheckoutStepPayload): void => {
    if (step.step === 'failed') {
      flow = 'fail';
      const stage = String(step.detail['stage'] ?? '');
      const reason = String(step.detail['reason'] ?? '');
      el('pay-status').innerHTML = `<span class="down">失敗</span> — ${escapeHtml(stage)} / ${escapeHtml(reason)}`;
      return;
    }
    const id = step.step;
    setRowState(id, step.ok ? 'ok' : 'fail');
    setRowDetail(id, detailText(step));
  };

  const pump = (): void => {
    if (revealing) return;
    const next = queue.shift();
    if (!next) {
      revealing = false;
      return;
    }
    revealing = true;
    // 次に点く段を active に（見えている進行）。
    if (next.step !== 'failed') setRowState(next.step, 'active');
    window.setTimeout(() => {
      applyStep(next);
      revealing = false;
      pump();
    }, Math.max(0, stepDelay));
  };

  return {
    setMode(status) {
      mode = status.mode;
      explorerBase = status.explorer;
      const banner = el('mock-banner');
      if (status.mode === 'testnet') {
        // 実 testnet。mainnet と誤認させないため network を明示。tx は実物（mock: を付けない）。
        banner.textContent = `Base Sepolia testnet — 実 tx（mainnet ではない）${status.network ? ` / ${status.network}` : ''}`;
        banner.dataset['mode'] = 'testnet';
        el('pay-mode').textContent = ' — Base Sepolia testnet';
        setRowLabel('signed', '支払い送信（実 EIP-712 署名）');
        setRowLabel('settled', '清算（実 tx 着金）');
      } else if (status.mode === 'mock') {
        banner.textContent = 'mock settlement — 実チェーンではない（区分A・鍵/外部到達なし）';
        banner.dataset['mode'] = 'mock';
        el('pay-mode').textContent = ' — mock';
      } else {
        banner.textContent = '決済は無効（NA_X402_MOCK=1 または NA_X402_TESTNET=1 で有効）';
        banner.dataset['mode'] = 'disabled';
        el('pay-mode').textContent = ' — 無効';
      }
    },
    isBuyOpen: () => buyOpen,
    isRunning: () => running || queue.length > 0 || revealing,
    buyTarget: () => target,
    setStepDelay: (ms) => {
      stepDelay = ms;
    },
    openBuy(next) {
      target = next;
      buyOpen = true;
      el('buy-label').textContent = `${next.label} ×${next.quantity}`;
      el('buy-amount').textContent = String(next.amount);
      el('buy-unit').textContent = next.unitPrice.toFixed(1);
      buyBox.hidden = false;
    },
    closeBuy() {
      buyOpen = false;
      buyBox.hidden = true;
    },
    begin(next, buyerKind) {
      target = next;
      buyOpen = false;
      buyBox.hidden = true;
      running = true;
      flow = 'running';
      queue.length = 0;
      revealing = false;
      resetRows();
      const buyerTag = el('pay-buyer');
      buyerTag.textContent = buyerKind === 'agent' ? '買い手: エージェント' : '買い手: あなた';
      el('pay-status').innerHTML =
        `<span class="dim">決済中</span> — ${escapeHtml(next.label)} ×${next.quantity} / ${next.amount}`;
    },
    pushStep(step) {
      queue.push(step);
      pump();
    },
    finish(result) {
      running = false;
      // 点灯（reveal）の完了を待ってから結果を確定する。
      return new Promise<void>((resolve) => {
        const settle = (): void => {
          if (this.isRunning()) {
            window.setTimeout(settle, 60);
            return;
          }
          if (result.ok && result.receipt && result.ledger) {
            flow = 'ok';
            const tx = String(result.settlement?.['transaction'] ?? (mode === 'testnet' ? '' : 'mock-tx'));
            // testnet は実 tx をエクスプローラのリンクで出す（mock: は付けない）。mock はそのまま。
            const txHtml =
              mode === 'testnet' && explorerBase && tx !== ''
                ? `<a href="${escapeHtml(explorerBase + tx)}" target="_blank" rel="noopener" class="mono">${escapeHtml(tx)}</a>`
                : `<span class="mono">${escapeHtml(tx)}</span>`;
            el('pay-status').innerHTML =
              `<span class="up">完了</span> — tx ${txHtml} ` +
              `/ credits ${result.ledger.credits} / 手持ち ${result.ledger.held}/${result.ledger.capacity}` +
              (result.standing ? ` / standing ${result.standing.score}` : '');
          } else if (!result.ok) {
            flow = 'fail';
            const stage = result.failure?.stage ?? 'unknown';
            const reason = result.failure?.reason ?? 'unknown';
            el('pay-status').innerHTML = `<span class="down">失敗</span> — ${escapeHtml(stage)} / ${escapeHtml(reason)}`;
          }
          resolve();
        };
        settle();
      });
    },
    fail(message) {
      running = false;
      queue.length = 0;
      revealing = false;
      buyOpen = false;
      buyBox.hidden = true;
      flow = 'fail';
      el('pay-status').innerHTML = `<span class="down">失敗</span> — ${escapeHtml(message)}`;
    },
    stepStates: () =>
      STEP_ROWS.map((r) => ({
        step: r.id,
        state: (rowFor(r.id).querySelector<HTMLElement>('.pay-dot')?.dataset['state'] ?? 'pending') as RowState,
      })),
    flowState: () => flow,
  };
}

function detailText(step: CheckoutStepPayload): string {
  switch (step.step) {
    case 'challenge':
      return `価格 ${String(step.detail['amount'] ?? '')} / feePayer ${String(step.detail['feePayer'] ?? '—')}`;
    case 'signed':
      // mock は署名文字列、testnet は scheme/network（実署名は SDK 内で作られる）。
      return step.detail['signature'] !== undefined
        ? String(step.detail['signature'])
        : `${String(step.detail['scheme'] ?? 'exact')} / ${String(step.detail['network'] ?? '')}`;
    case 'verified':
      return `payment_valid: ${String(step.detail['payment_valid'])}`;
    case 'settled':
      return `tx ${String(step.detail['transaction'] ?? '')}（onChain: ${String(step.detail['onChain'])}）`;
    default:
      return '';
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
