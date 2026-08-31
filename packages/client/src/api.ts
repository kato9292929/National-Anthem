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

export interface SessionPayload {
  identity: Identity;
  wallet: Wallet | null;
  wallets: Wallet[];
  standing: Standing;
  rooms: {
    id: string;
    label_ja: string;
    namePlaceholder: string;
    nameConfirmed: boolean;
    gate: RoomGateResult;
  }[];
  notes: { auth: string; walletVerification: string };
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
