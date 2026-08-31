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
  port: number;
  /** 指定すると同一オリジンでクライアントの静的ファイルを配信する。 */
  clientDist?: string | undefined;
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

      case 'GET /api/agent/status':
        sendJson(res, 200, options.agentStatus());
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

    if (req.method === 'GET' && options.clientDist) {
      if (serveStatic(options.clientDist, url.pathname, res)) return;
    }
    sendJson(res, 404, { error: 'not_found', path: url.pathname });
  }

  return server;
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
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
