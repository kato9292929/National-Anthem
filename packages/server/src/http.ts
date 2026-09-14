import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { resolveAllNames, unconfirmedNames, type ReputationEventKind, type RoomsConfig, type WorldConfig } from '@na/shared';
import type { IdentityService } from './identity/service.js';
import type { MarketSimulation } from './market/simulation.js';

export interface HttpOptions {
  config: WorldConfig;
  configPath: string;
  sim: MarketSimulation;
  identity: IdentityService;
  roomsConfig: RoomsConfig;
  /** 認証は未実装。ローカルの単一 session identity（仮）。 */
  localPlayerId: string;
  x402Status: () => unknown;
  privacyStatus: () => unknown;
  agentStatus: () => unknown;
  adapterStatus: () => unknown;
  presentationConfig: () => unknown;
  /** 402 でゲートする資源。無効なら常に null を返す。 */
  paywall: {
    enabled: boolean;
    /** 支払いヘッダの名前（config 由来）。 */
    headerName: string;
    guard(input: { paymentSignature: string | undefined; resource: string; description: string }): Promise<
      | { kind: 'disabled' }
      | { kind: 'challenge'; response: { status: number; headers: Record<string, string>; body: string } }
      | { kind: 'paid'; headers: Record<string, string> }
    >;
  };
  commissionBoard: () => unknown;
  commissionAction: (body: Record<string, unknown>) => Promise<unknown>;
  storefrontListing: () => unknown;
  storefrontBuy: (body: Record<string, unknown>) => unknown;
  /** 買い手の手持ち（credits / inventory）。session に載せる。 */
  ledgerState: (buyerId: string) => unknown;
  /** 決済モード（mock / testnet / 無効）。画面のラベルに使う。 */
  checkoutStatus: () => unknown;
  /**
   * 物販デモの x402 決済フロー（区分A・mock）。
   * 段階ごとの実イベントを onStep で流し、最後に結果を返す。無効なら enabled:false。
   */
  storefrontCheckout: {
    enabled: boolean;
    run(
      body: Record<string, unknown>,
      onStep: (step: unknown) => void,
    ): Promise<{ ok: boolean; failure: unknown; receipt: unknown; ledger: unknown; standing: unknown; settlement: unknown }>;
  };
  port: number;
  /** 指定すると同一オリジンでクライアントの静的ファイルを配信する。 */
  clientDist?: string | undefined;
  /** 生成メッシュ等のアセットを /assets/ で配信する（スモーク検証用）。 */
  assetsDir?: string | undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
};

export function createHttpServer(options: HttpOptions) {
  const { config, configPath, sim, identity, roomsConfig, localPlayerId } = options;

  /** session identity の現在地。room gate は standing で開閉する（world-spec §1 の印章の履歴）。 */
  const sessionView = (): unknown => {
    const player = identity.identity(localPlayerId);
    return {
      identity: player,
      wallet: identity.activeWallet(localPlayerId),
      wallets: identity.walletsOf(localPlayerId),
      standing: identity.standing(localPlayerId),
      reputation: identity.reputationOf(localPlayerId),
      ledger: options.ledgerState(localPlayerId),
      rooms: roomsConfig.rooms.map((room) => ({
        id: room.id,
        label_ja: room.label_ja,
        namePlaceholder: room.name_placeholder,
        nameConfirmed: room.name_confirmed,
        gate: identity.canEnter(localPlayerId, room.id),
      })),
      notes: {
        auth: '認証は未実装。ローカルの単一 session identity（仮）',
        walletVerification: '実 wallet / ERC-8004 照会は未検証（区分B）',
      },
    };
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // 例外は隠さない。500 と本文で出す。
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: 'internal_error', message });
    });
  });

  /**
   * 402 のゲート。gated が true なら 402 を返し終えているので呼び出し側は進まない。
   * 通った場合は settle 結果のヘッダを返し、200 にも載せる。
   */
  async function guardPayment(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    description: string,
  ): Promise<{ gated: boolean; headers: Record<string, string> }> {
    if (!options.paywall.enabled) return { gated: false, headers: {} };
    const raw = req.headers[options.paywall.headerName.toLowerCase()];
    const paymentSignature = Array.isArray(raw) ? raw[0] : raw;
    const result = await options.paywall.guard({
      paymentSignature,
      resource: url.href,
      description,
    });
    if (result.kind === 'challenge') {
      res.writeHead(result.response.status, result.response.headers);
      res.end(result.response.body);
      return { gated: true, headers: {} };
    }
    return { gated: false, headers: result.kind === 'paid' ? result.headers : {} };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${options.port}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/health':
        sendJson(res, 200, { ok: true, tick: sim.tick, seed: sim.seed });
        return;

      case 'GET /api/world/config':
        // 固有名はここから配る。クライアントはリテラルを持たない。
        sendJson(res, 200, {
          config,
          configPath,
          names: resolveAllNames(config),
          unconfirmedNames: unconfirmedNames(config),
        });
        return;

      case 'GET /api/market/state':
        sendJson(res, 200, sim.state(Date.now()));
        return;

      case 'GET /api/commission/board':
        sendJson(res, 200, options.commissionBoard());
        return;

      case 'POST /api/commission/action': {
        const body = (await readJson(req)) as Record<string, unknown>;
        // 封印精算は有料の資源。402 でゲートする（払う先の資源＝ここ）。
        let paymentHeaders: Record<string, string> = {};
        if (String(body['action'] ?? '') === 'settle') {
          const gate = await guardPayment(req, res, url, '委託の封印精算');
          if (gate.gated) return;
          paymentHeaders = gate.headers;
        }
        sendJson(res, 200, await options.commissionAction(body), paymentHeaders);
        return;
      }

      case 'GET /api/storefront/listing':
        sendJson(res, 200, options.storefrontListing());
        return;

      case 'POST /api/storefront/buy': {
        const body = (await readJson(req)) as Record<string, unknown>;
        const gate = await guardPayment(req, res, url, '物販の購入');
        if (gate.gated) return;
        sendJson(res, 200, options.storefrontBuy(body), gate.headers);
        return;
      }

      case 'GET /api/checkout/status':
        sendJson(res, 200, options.checkoutStatus());
        return;

      case 'GET /api/x402/paid-resource': {
        // testnet 決済の払い先（自分の paywall 資源）。paywall 有効時のみ意味を持つ。
        // 未払いなら guardPayment が 402 を返す。払い済みなら settle 結果ヘッダ付きで 200。
        const gate = await guardPayment(req, res, url, '物販デモの testnet 決済');
        if (gate.gated) return;
        sendJson(res, 200, { ok: true, resource: url.pathname }, gate.headers);
        return;
      }

      case 'POST /api/storefront/checkout': {
        // 物販デモの決済フロー（区分A・mock）。段階を NDJSON で流す。
        const body = (await readJson(req)) as Record<string, unknown>;
        if (!options.storefrontCheckout.enabled) {
          sendJson(res, 400, {
            error: 'checkout_disabled',
            message: '物販デモの mock 決済は無効。NA_X402_MOCK=1 で有効になる（区分A）',
          });
          return;
        }
        await streamCheckout(res, body, options.storefrontCheckout.run);
        return;
      }

      case 'GET /api/agent/status':
        sendJson(res, 200, options.agentStatus());
        return;

      case 'GET /api/presentation/config':
        // 見た目の設定はそのまま配る。サーバ側で値を解釈しない。
        sendJson(res, 200, options.presentationConfig());
        return;

      case 'GET /api/adapters/status':
        sendJson(res, 200, options.adapterStatus());
        return;

      case 'GET /api/privacy/status':
        sendJson(res, 200, options.privacyStatus());
        return;

      case 'GET /api/x402/status':
        sendJson(res, 200, options.x402Status());
        return;

      case 'GET /api/identity/session':
        sendJson(res, 200, sessionView());
        return;

      case 'POST /api/identity/rotate': {
        const wallet = identity.activeWallet(localPlayerId);
        if (!wallet) throw new Error('active な wallet が無い');
        const rotated = identity.rotateWallet(wallet.id, 'api');
        sendJson(res, 200, { rotated, standing: identity.standing(localPlayerId) });
        return;
      }

      case 'POST /api/identity/agent': {
        // 開発用フック: ローカル principal の下に代理エージェントの identity を立てる。
        const agent = identity.createIdentity({ kind: 'agent', principalId: localPlayerId });
        const wallet = identity.createSessionWallet(agent.id);
        sendJson(res, 200, { agent, wallet, standing: identity.standing(agent.id) });
        return;
      }

      case 'POST /api/identity/reputation': {
        // standing を動かす開発用フック。実運用では M7 の commission 完了から積む。
        const body = (await readJson(req)) as Record<string, unknown>;
        const event = identity.recordReputation({
          identityId: String(body['identityId'] ?? localPlayerId),
          kind: String(body['kind'] ?? '') as ReputationEventKind,
          ref: body['ref'] === undefined ? null : String(body['ref']),
          note: String(body['note'] ?? 'dev hook'),
        });
        sendJson(res, 200, { event, standing: identity.standing(localPlayerId) });
        return;
      }

      case 'POST /api/market/shock': {
        const body = await readJson(req);
        const shock = sim.applyShock({
          itemId: String((body as Record<string, unknown>)['itemId'] ?? ''),
          supplyMultiplier: Number((body as Record<string, unknown>)['supplyMultiplier']),
          durationTicks: Number((body as Record<string, unknown>)['durationTicks']),
          note: String((body as Record<string, unknown>)['note'] ?? 'manual'),
        });
        sendJson(res, 200, shock);
        return;
      }

      default:
        break;
    }

    if (req.method === 'GET' && options.assetsDir && url.pathname.startsWith('/assets/')) {
      if (serveStatic(options.assetsDir, url.pathname.slice('/assets'.length), res)) return;
    }
    if (req.method === 'GET' && options.clientDist) {
      if (serveStatic(options.clientDist, url.pathname, res)) return;
    }
    sendJson(res, 404, { error: 'not_found', path: url.pathname });
  }

  return server;
}

/**
 * 決済フローを NDJSON（1 行 1 イベント）で流す。各行は実際の処理の結果に紐づく。
 * 事前確認（在庫・credits・容量）で落ちたら、まだ本文を書いていないので 400 を返す。
 * ストリーム開始後の失敗（検証・清算）は failed 行として流し、成功に見せない。
 */
async function streamCheckout(
  res: ServerResponse,
  body: Record<string, unknown>,
  run: (
    body: Record<string, unknown>,
    onStep: (step: unknown) => void,
  ) => Promise<{ ok: boolean; failure: unknown; receipt: unknown; ledger: unknown; standing: unknown; settlement: unknown }>,
): Promise<void> {
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
  };
  const writeLine = (obj: unknown): void => {
    start();
    res.write(`${JSON.stringify(obj)}\n`);
  };

  try {
    const outcome = await run(body, (step) => writeLine({ kind: 'step', step }));
    writeLine({
      kind: 'result',
      ok: outcome.ok,
      failure: outcome.failure,
      receipt: outcome.receipt,
      ledger: outcome.ledger,
      standing: outcome.standing,
      settlement: outcome.settlement,
    });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!started) {
      // 事前確認で落ちた（在庫不足・credits 不足など）。まだ何も書いていない。
      sendJson(res, 400, { error: 'checkout_precondition_failed', message });
      return;
    }
    // ストリーム途中の例外。失敗として流して終える（握りつぶさない）。
    writeLine({ kind: 'result', ok: false, failure: { stage: 'error', reason: message }, receipt: null, ledger: null, standing: null, settlement: null });
    res.end();
  }
}

function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  const rootDir = resolve(root);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const candidate = resolve(join(rootDir, normalize(requested)));
  if (!candidate.startsWith(rootDir)) return false;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' });
  createReadStream(candidate).pipe(res);
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}
