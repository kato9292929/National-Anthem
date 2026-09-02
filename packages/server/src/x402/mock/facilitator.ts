import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ローカルの mock facilitator（区分A の一周確認用）。
 * 実 facilitator（PayAI）への疎通は区分B。ここは実網に一切出ない。
 * feePayer をローテートさせ、クライアントが毎回 402 から取り直すかを確かめられるようにする。
 */

export interface FacilitatorCall {
  kind: 'verify' | 'settle';
  body: Record<string, unknown>;
}

export interface MockFacilitator {
  url: string;
  calls: FacilitatorCall[];
  /** 次に 402 で出す feePayer。呼ぶたびに進む。 */
  nextFeePayer(): string;
  close(): Promise<void>;
  server: Server;
}

export interface MockFacilitatorOptions {
  feePayers?: string[];
  /** false を返すと verify が通らない。異常系の確認に使う。 */
  accept?: (payload: Record<string, unknown>) => boolean;
}

export async function startMockFacilitator(options: MockFacilitatorOptions = {}): Promise<MockFacilitator> {
  const feePayers = options.feePayers ?? ['mock:feePayer:A', 'mock:feePayer:B', 'mock:feePayer:C'];
  const accept = options.accept ?? (() => true);
  const calls: FacilitatorCall[] = [];
  let feePayerIndex = -1;
  let settleCount = 0;
  // 同じ支払いを 2 回 settle させない（二重支払いの検出）。
  const settledSignatures = new Set<string>();

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      const body = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
      const payload = (body['paymentPayload'] ?? {}) as Record<string, unknown>;

      if (req.url === '/supported') {
        // PayAI の /supported を模す。feePayer は呼ぶたびにローテートする。
        const feePayer = feePayers[(feePayerIndex + 1) % feePayers.length]!;
        send(res, 200, {
          kinds: [
            { x402Version: 2, scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', extra: { feePayer } },
          ],
        });
        return;
      }

      if (req.url === '/verify') {
        calls.push({ kind: 'verify', body });
        const isValid = accept(payload);
        send(res, 200, { isValid, invalidReason: isValid ? null : 'mock_rejected' });
        return;
      }
      if (req.url === '/settle') {
        calls.push({ kind: 'settle', body });
        const inner = (payload['payload'] ?? {}) as Record<string, unknown>;
        const signature = String(inner['signature'] ?? '');
        if (signature !== '' && settledSignatures.has(signature)) {
          send(res, 200, { success: false, errorReason: 'payment_replayed' });
          return;
        }
        if (signature !== '') settledSignatures.add(signature);
        settleCount += 1;
        send(res, 200, {
          success: true,
          transaction: `mock-tx-${settleCount}`,
          network: String(payload['network'] ?? ''),
          payer: String(inner['payer'] ?? 'mock:payer'),
        });
        return;
      }
      send(res, 404, { error: 'not_found', path: req.url });
    })().catch((error: unknown) => {
      send(res, 500, { error: 'mock_facilitator_error', message: (error as Error).message });
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    nextFeePayer() {
      feePayerIndex = (feePayerIndex + 1) % feePayers.length;
      return feePayers[feePayerIndex]!;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
    server,
  };
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
