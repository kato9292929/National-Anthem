import type {
  Identity,
  MarketState,
  NamingKey,
  ResolvedName,
  RoomGateResult,
  Standing,
  Wallet,
  WorldConfig,
} from '@na/shared';

/**
 * サーバ（M1）だけが市場の真実を持つ。クライアントは取得して描くだけ。
 * 失敗はフォールバックで隠さず、そのまま呼び出し元へ投げる。
 */

export interface WorldPayload {
  config: WorldConfig;
  configPath: string;
  names: Record<NamingKey, ResolvedName>;
  unconfirmedNames: NamingKey[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`${path} が ${res.status} を返した`);
  }
  return (await res.json()) as T;
}

export function fetchWorld(): Promise<WorldPayload> {
  return getJson<WorldPayload>('/api/world/config');
}

export function fetchMarketState(): Promise<MarketState> {
  return getJson<MarketState>('/api/market/state');
}

export interface LedgerPayload {
  buyerId: string;
  credits: number;
  inventory: { itemId: string; quantity: number }[];
  held: number;
  capacity: number;
  startingCredits: number;
  purchases: number;
  provisional: boolean;
}

export interface SessionPayload {
  identity: Identity;
  wallet: Wallet | null;
  wallets: Wallet[];
  standing: Standing;
  ledger: LedgerPayload;
  rooms: {
    id: string;
    label_ja: string;
    namePlaceholder: string;
    nameConfirmed: boolean;
    gate: RoomGateResult;
  }[];
  notes: { auth: string; walletVerification: string };
}

/** 決済フローの 1 段。バックエンドの実イベントに紐づく（演出ではない）。 */
export interface CheckoutStepPayload {
  step: 'challenge' | 'signed' | 'verified' | 'settled' | 'failed';
  ok: boolean;
  at: number;
  detail: Record<string, unknown>;
}

export interface CheckoutResultPayload {
  kind: 'result';
  ok: boolean;
  failure: { stage: string; reason: string } | null;
  receipt: { id: string; itemId: string; quantity: number; amount: string } | null;
  ledger: LedgerPayload | null;
  standing: Standing | null;
  settlement: Record<string, unknown> | null;
}

/**
 * 物販デモの mock 決済（区分A）。NDJSON を読み、段階ごとに onStep を呼ぶ。
 * 各段はバックエンドが実際にその処理を終えたときの結果。UI だけで成功を先に描かない。
 * 事前確認（在庫・credits）で落ちると 400 を投げる（成功に見せない）。
 */
export async function checkout(
  body: { itemId: string; quantity: number; buyerId?: string; simulateFailure?: 'verify' | 'settle' },
  onStep: (step: CheckoutStepPayload) => void,
): Promise<CheckoutResultPayload> {
  const res = await fetch('/api/storefront/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let message = `checkout が ${res.status} を返した`;
    try {
      const err = (await res.json()) as { message?: string };
      if (err.message) message = err.message;
    } catch {
      /* 本文が JSON でない */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: CheckoutResultPayload | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line) as
        | { kind: 'step'; step: CheckoutStepPayload }
        | CheckoutResultPayload;
      if (message.kind === 'step') onStep(message.step);
      else result = message;
    }
  }
  if (!result) throw new Error('checkout の結果が返らなかった（ストリームが途切れた）');
  return result;
}

export interface CommissionBoardPayload {
  modules: { primary: string; secondary: string };
  flow: { legs: string; remote_handling: string; settlement_unit: string; confirmed: boolean };
  escrow: { unit: string; confirmed: boolean };
  commissions: {
    id: string;
    itemId: string;
    state: string;
    provisional: boolean;
    amount: string;
    escrow: { state: string } | null;
  }[];
}

export function fetchCommissionBoard(): Promise<CommissionBoardPayload> {
  return getJson<CommissionBoardPayload>('/api/commission/board');
}

export interface CheckoutStatusPayload {
  enabled: boolean;
  mode: 'mock' | 'testnet' | 'disabled';
  rail: string;
  network: string | null;
  testnet: boolean;
  assetLabel: string | null;
  explorer: string | null;
  label: string;
}

export function fetchCheckoutStatus(): Promise<CheckoutStatusPayload> {
  return getJson<CheckoutStatusPayload>('/api/checkout/status');
}

export function fetchSession(): Promise<SessionPayload> {
  return getJson<SessionPayload>('/api/identity/session');
}

/** session（standing / room gate）を一定間隔で引く。市場と同じく、失敗は隠さない。 */
export function pollSession(
  intervalMs: number,
  onSession: (session: SessionPayload) => void,
  onError: (error: Error) => void,
): MarketPoll {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      onSession(await fetchSession());
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  void tick();
  const timer = window.setInterval(() => void tick(), intervalMs);
  return {
    stop() {
      stopped = true;
      window.clearInterval(timer);
    },
  };
}

export interface MarketPoll {
  stop(): void;
}

/** 一定間隔でサーバ状態を引く。前回値の使い回しはしない（古い値は古いと分かる形で扱う）。 */
export function pollMarketState(
  intervalMs: number,
  onState: (state: MarketState) => void,
  onError: (error: Error) => void,
): MarketPoll {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      onState(await fetchMarketState());
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  void tick();
  const timer = window.setInterval(() => void tick(), intervalMs);
  return {
    stop() {
      stopped = true;
      window.clearInterval(timer);
    },
  };
}
