import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PaymentLeg, X402Config } from '@na/shared';
import { encodeHeader } from '../client.js';

/**
 * 課金付きリソースの mock（区分A）。402 → X-PAYMENT 再送 → settle の相手役。
 * 検証は verifier に委ねる。M5 の privacy gateway をここに差し込む。
 */

export interface PaymentVerification {
  /** 返るのはこれだけ。送金元・金額・エンドポイントは受け取らない。 */
  payment_valid: boolean;
}

export type PaymentVerifier = (input: {
  payload: Record<string, unknown>;
  leg: PaymentLeg;
}) => Promise<PaymentVerification>;

export interface MockResourceServer {
  url: string;
  close(): Promise<void>;
  server: Server;
  /** 402 を出した回数。feePayer のローテート確認に使う。 */
  challenges: { feePayer: string }[];
}

export interface MockResourceOptions {
  config: X402Config;
  railId: string;
  amount?: string;
  /** 402 に載せる期限（ms 後）。省略すると期限を載せない。 */
  expiresInMs?: number;
  /** feePayer を載せない 402 を返す（異常系の確認用）。 */
  omitFeePayer?: boolean;
  /** 402 のたびに呼ぶ。ローテートする feePayer を返す。 */
  nextFeePayer: () => string;
  verifier: PaymentVerifier;
  settle: (input: { payload: Record<string, unknown>; leg: PaymentLeg }) => Promise<Record<string, unknown>>;
}

export async function startMockResourceServer(options: MockResourceOptions): Promise<MockResourceServer> {
  const rail = options.config.rails.find((r) => r.id === options.railId);
  if (!rail) throw new Error(`config に無い rail: ${options.railId}`);
  if (!rail.confirmed) throw new Error(`未確定の rail では 402 を出せない: ${rail.id}`);
  const challenges: { feePayer: string }[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const paymentHeader = req.headers[options.config.protocol.paymentHeader.toLowerCase()];
      const feePayer = paymentHeader === undefined && !options.omitFeePayer ? options.nextFeePayer() : null;

      const leg: PaymentLeg = {
        scheme: options.config.protocol.scheme,
        network: rail.network,
        asset: rail.asset,
        amount: options.amount ?? rail.defaultAmount,
        payTo: rail.payTo,
        resource: req.url ?? '/',
        description: 'mock paywalled resource',
        ...(options.expiresInMs === undefined
          ? {}
          : { [options.config.protocol.legExpiryField]: Date.now() + options.expiresInMs }),
        ...(feePayer ? { extra: { feePayer } } : {}),
      } as PaymentLeg;

      if (typeof paymentHeader !== 'string') {
        challenges.push({ feePayer: feePayer! });
        // 402 の本文は {}。要求は PAYMENT-REQUIRED ヘッダに載せる。
        res.writeHead(402, {
          'content-type': 'application/json',
          [options.config.protocol.requirementsHeader]: encodeHeader({
            x402Version: options.config.protocol.x402Version,
            accepts: [leg],
          }),
        });
        res.end('{}');
        return;
      }

      const payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as Record<
        string,
        unknown
      >;
      const verification = await options.verifier({ payload, leg });
      if (!verification.payment_valid) {
        send(res, 402, { error: 'payment_invalid' });
        return;
      }
      const settlement = await options.settle({ payload, leg });
      if (settlement['success'] === false) {
        // settle が通らなければ 200 を返さない（成功に見せない）。
        send(res, 402, { error: 'settle_failed', detail: settlement });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        [options.config.protocol.paymentResponseHeader]: encodeHeader(settlement),
      });
      res.end(JSON.stringify({ ok: true, resource: req.url }));
    })().catch((error: unknown) => {
      send(res, 500, { error: 'mock_resource_error', message: (error as Error).message });
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
    server,
    challenges,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
