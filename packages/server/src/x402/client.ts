import type {
  PaymentLeg,
  PaymentPayload,
  PaymentRequirements,
  RailConfig,
  SettleResult,
  X402Config,
} from '@na/shared';
import type { PaymentSigner } from './signer.js';

/**
 * native withX402 v2 クライアント。
 * - 402 は PAYMENT-REQUIRED ヘッダで来る（body は {}）。top-level に x402Version:2、leg は amount。
 * - feePayer は毎回 accepts[].extra.feePayer から取る。config にもキャッシュにも置かない。
 * - レールは資産・ネットワークの完全一致でだけ選ぶ。bridge しない。
 * - 想定外のレスポンスはフォールバックせずに落とす。
 */

export interface X402Event {
  kind: 'payment_required' | 'leg_selected' | 'payment_sent' | 'settled' | 'failed';
  detail: Record<string, unknown>;
}

export interface WithX402Options {
  config: X402Config;
  signers: PaymentSigner[];
  fetchImpl?: typeof fetch;
  onEvent?: (event: X402Event) => void;
}

export interface X402Result {
  response: Response;
  /** 支払いが要らなかった場合は null。 */
  payment: {
    railId: string;
    leg: PaymentLeg;
    feePayer: string | null;
    settlement: SettleResult;
  } | null;
}

export class X402Error extends Error {
  override readonly name = 'X402Error';
  constructor(message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function withX402(
  url: string,
  init: RequestInit,
  options: WithX402Options,
): Promise<X402Result> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { config } = options;

  const first = await fetchImpl(url, init);
  if (first.status !== 402) return { response: first, payment: null };

  const requirements = parseRequirements(first, config);
  options.onEvent?.({ kind: 'payment_required', detail: { accepts: requirements.accepts.length } });

  const { leg, rail, signer } = selectLeg(requirements, config, options.signers);
  assertNotExpired(leg, config);
  // feePayer はローテートする。毎回この 402 の値を読む。
  const feePayer = readFeePayer(leg);
  if (rail.requiresFeePayer && feePayer === null) {
    throw new X402Error(`rail ${rail.id} は extra.feePayer が要るのに 402 に入っていない`, {
      railId: rail.id,
      source: config.feePayer.source,
    });
  }
  options.onEvent?.({ kind: 'leg_selected', detail: { railId: rail.id, network: leg.network, feePayer } });

  const signed = await signer.sign({ leg, rail, feePayer, resourceUrl: url });
  const payload: PaymentPayload = {
    x402Version: config.protocol.x402Version,
    scheme: leg.scheme,
    network: leg.network,
    payload: signed,
  };

  const headers = new Headers(init.headers);
  headers.set(config.protocol.paymentHeader, encodeHeader(payload));
  options.onEvent?.({ kind: 'payment_sent', detail: { railId: rail.id, amount: leg.amount } });

  const second = await fetchImpl(url, { ...init, headers });
  if (second.status === 402) {
    throw new X402Error('再送しても 402 が返った。ループさせずに落とす', {
      railId: rail.id,
      body: await safeText(second),
    });
  }
  if (!second.ok) {
    throw new X402Error(`支払い後に ${second.status} が返った`, {
      railId: rail.id,
      body: await safeText(second),
    });
  }

  const settlement = parseSettlement(second, config);
  if (!settlement.success) {
    throw new X402Error('settle が成功しなかった', { railId: rail.id, settlement });
  }
  options.onEvent?.({ kind: 'settled', detail: { railId: rail.id, transaction: settlement.transaction } });

  return { response: second, payment: { railId: rail.id, leg, feePayer, settlement } };
}

/** PAYMENT-REQUIRED ヘッダを読む。形が違えば黙って進めずに落とす。 */
export function parseRequirements(response: Response, config: X402Config): PaymentRequirements {
  const raw = response.headers.get(config.protocol.requirementsHeader);
  if (raw === null || raw === '') {
    throw new X402Error(`402 に ${config.protocol.requirementsHeader} ヘッダが無い`);
  }
  const parsed = decodeHeader(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new X402Error(`${config.protocol.requirementsHeader} の中身がオブジェクトでない`);
  }
  const body = parsed as Record<string, unknown>;
  if (body['x402Version'] !== config.protocol.x402Version) {
    throw new X402Error(
      `x402Version が想定外（期待 ${config.protocol.x402Version} / 実際 ${String(body['x402Version'])}）`,
    );
  }
  const accepts = body['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new X402Error('accepts が空。払える leg が無い');
  }
  return {
    x402Version: config.protocol.x402Version,
    accepts: accepts.map((leg, index) => normalizeLeg(leg, index, config)),
  };
}

/**
 * accepts の 1 件を読む。
 * 稼働プロダクトの 402 は v1 leg（maxAmountRequired）と v2 leg（amount）を併記するので、
 * v1 leg は「読めない」ではなく「v1 として読む」。払う leg の選択は selectLeg 側で行う。
 */
function normalizeLeg(input: unknown, index: number, config: X402Config): PaymentLeg {
  if (typeof input !== 'object' || input === null) {
    throw new X402Error(`accepts[${index}] がオブジェクトでない`);
  }
  const leg = input as Record<string, unknown>;
  const amountField = config.protocol.legAmountField;
  const v1Field = config.protocol.legAmountFieldV1;
  const rawAmount = leg[amountField] ?? leg[v1Field];
  if (rawAmount === undefined) {
    throw new X402Error(`accepts[${index}] に ${amountField} も ${v1Field} も無い`);
  }
  const legVersion: 1 | 2 = leg[amountField] === undefined ? 1 : 2;
  for (const key of ['scheme', 'network', 'asset', 'payTo'] as const) {
    if (typeof leg[key] !== 'string' || leg[key] === '') {
      throw new X402Error(`accepts[${index}].${key} が空`);
    }
  }
  return {
    scheme: leg['scheme'] as string,
    network: leg['network'] as string,
    asset: leg['asset'] as string,
    amount: String(rawAmount),
    legVersion,
    payTo: leg['payTo'] as string,
    ...(typeof leg['resource'] === 'string' ? { resource: leg['resource'] } : {}),
    ...(typeof leg['description'] === 'string' ? { description: leg['description'] } : {}),
    ...(typeof leg[config.protocol.legExpiryField] === 'number'
      ? { expiresAt: leg[config.protocol.legExpiryField] as number }
      : {}),
    ...(typeof leg['maxTimeoutSeconds'] === 'number' ? { maxTimeoutSeconds: leg['maxTimeoutSeconds'] } : {}),
    ...(typeof leg['extra'] === 'object' && leg['extra'] !== null
      ? { extra: leg['extra'] as Record<string, unknown> }
      : {}),
  };
}

/**
 * 期限切れの 402 では署名しない。
 * 期限がどのフィールドで来るかは未確定（config の legExpiryField が仮）なので、
 * 期限が無い 402 は「期限なし」として扱い、勝手な既定値を置かない。
 */
export function assertNotExpired(leg: PaymentLeg, config: X402Config, now: number = Date.now()): void {
  if (leg.expiresAt === undefined) return;
  if (leg.expiresAt <= now) {
    throw new X402Error('402 の期限が切れている。期限切れのまま署名しない', {
      expiresAt: leg.expiresAt,
      now,
      field: config.protocol.legExpiryField,
      fieldConfirmed: config.protocol.legExpiryConfirmed,
    });
  }
}

/** feePayer は 402 の extra からのみ。無ければ null を返し、既定値で埋めない。 */
export function readFeePayer(leg: PaymentLeg): string | null {
  const value = leg.extra?.['feePayer'];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === '') {
    throw new X402Error('extra.feePayer が文字列でない');
  }
  return value;
}

export interface SelectedLeg {
  leg: PaymentLeg;
  rail: RailConfig;
  signer: PaymentSigner;
}

/**
 * 資産とネットワークの完全一致でレールを選ぶ。
 * 一致する rail が未確定（TBD）／署名鍵が無い場合は、別レールへ振り替えずに落とす。
 */
export function selectLeg(
  requirements: PaymentRequirements,
  config: X402Config,
  signers: PaymentSigner[],
): SelectedLeg {
  const reasons: string[] = [];
  for (const leg of requirements.accepts) {
    if (leg.legVersion === 1) {
      // v1 leg は併記されているだけ。v2 で払う。
      reasons.push(`${leg.network}: v1 leg（${config.protocol.legAmountFieldV1}）なので選ばない`);
      continue;
    }
    const rail = config.rails.find((r) => r.network === leg.network && r.asset === leg.asset);
    if (!rail) {
      reasons.push(`${leg.network} / ${leg.asset}: 対応する rail が config に無い`);
      continue;
    }
    if (!rail.confirmed) {
      reasons.push(`${rail.id}: rail が未確定（config が TBD）`);
      continue;
    }
    const signer = signers.find((s) => s.railIds.includes(rail.id) && s.chainKind === rail.chainKind);
    if (!signer) {
      reasons.push(`${rail.id}: 署名口が無い`);
      continue;
    }
    if (leg.payTo !== rail.payTo) {
      reasons.push(`${rail.id}: payTo が config と違う（402: ${leg.payTo} / config: ${rail.payTo}）`);
      continue;
    }
    return { leg, rail, signer };
  }
  throw new X402Error(
    `払える leg が無い。bridge はしない: ${reasons.join(' / ')}`,
    { bridgingAllowed: config.policy.bridgingAllowed },
  );
}

export function parseSettlement(response: Response, config: X402Config): SettleResult {
  const raw = response.headers.get(config.protocol.paymentResponseHeader);
  if (raw === null || raw === '') {
    throw new X402Error(`${config.protocol.paymentResponseHeader} が無い。settle 結果を確認できない`);
  }
  const parsed = decodeHeader(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new X402Error(`${config.protocol.paymentResponseHeader} の中身がオブジェクトでない`);
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body['success'] !== 'boolean') {
    throw new X402Error('settle 結果に success が無い');
  }
  return body as unknown as SettleResult;
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

/** base64 でも生 JSON でも読む。どちらでもなければ落とす。 */
export function decodeHeader(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch (cause) {
    throw new X402Error(`ヘッダを base64 として読めない: ${(cause as Error).message}`);
  }
  try {
    return JSON.parse(decoded);
  } catch (cause) {
    throw new X402Error(`ヘッダを JSON として読めない: ${(cause as Error).message}`);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return '(本文を読めない)';
  }
}
