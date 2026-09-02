import { arr, bool, num, obj, oneOf, str } from './guards.js';

/**
 * M4: native withX402 v2 の型。
 * 402 は PAYMENT-REQUIRED ヘッダで来て body は {}。top-level に x402Version: 2。
 * v2 の leg は amount。feePayer は accepts[].extra.feePayer から毎回取る（config に持たない）。
 */

export type ChainKind = 'solana' | 'evm';

export interface Eip712Domain {
  name: string;
  version: string;
  /** 未確認のレールでは null。 */
  chainId: number | null;
  confirmed: boolean;
}

export interface RailConfig {
  id: string;
  chainKind: ChainKind;
  /** CAIP-2。未確定なら "TBD"。 */
  network: string;
  asset: string;
  assetLabel: string;
  decimals: number;
  payTo: string;
  defaultAmount: string;
  confirmed: boolean;
  verified: boolean;
  eip712Domain: Eip712Domain | null;
  /** このレールは 402 の extra.feePayer が必須か。欠けていたら払わずに落とす。 */
  requiresFeePayer: boolean;
  /** v1 leg の network 名（現行クライアントが掴むのはこちら）。未確定なら "TBD"。 */
  networkV1: string;
}

export interface X402Config {
  version: string;
  protocol: {
    x402Version: number;
    scheme: string;
    requirementsHeader: string;
    paymentHeader: string;
    paymentResponseHeader: string;
    legAmountField: string;
    /** v1 leg の金額フィールド名。 */
    legAmountFieldV1: string;
    /** 有効期限がどのフィールドで来るかは未確定。仮のキー名。 */
    legExpiryField: string;
    legExpiryConfirmed: boolean;
    /** facilitator のパス。 */
    supportedPath: string;
    verifyPath: string;
    settlePath: string;
    /** accepts の各 leg に載せる値。 */
    maxTimeoutSeconds: number;
    mimeType: string;
    confirmed: boolean;
  };
  facilitator: { url: string; provider: string; confirmed: boolean; verified: boolean };
  feePayer: { source: string; hardcodedAllowed: boolean; ttlMs: number };
  rails: RailConfig[];
  policy: { bridgingAllowed: boolean; railSelection: string };
}

/** 402 の accepts[] 1 件（v2 leg）。 */
export interface PaymentLeg {
  scheme: string;
  network: string;
  asset: string;
  /** v2 は amount、v1 は maxAmountRequired。値は同じで、フィールド名だけが違う。 */
  amount: string;
  /** どちらの形で来た leg か。1 は併記されているだけで、払うのは 2。 */
  legVersion: 1 | 2;
  payTo: string;
  resource?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  /** 期限（epoch ms）。キー名は config の legExpiryField（仮）。 */
  expiresAt?: number;
  /** feePayer はここから取る。毎回読み直す。 */
  extra?: Record<string, unknown> & { feePayer?: string };
}

export interface PaymentRequirements {
  x402Version: number;
  accepts: PaymentLeg[];
  error?: string;
}

/** X-PAYMENT ヘッダに載せる中身。 */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
}

export interface SettleResult {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

export function validateX402Config(input: unknown, source: string): X402Config {
  const root = obj(input, source, '(root)');
  const protocol = obj(root['protocol'], source, 'protocol');
  const facilitator = obj(root['facilitator'], source, 'facilitator');
  const feePayer = obj(root['feePayer'], source, 'feePayer');
  const policy = obj(root['policy'], source, 'policy');

  if (bool(feePayer['hardcodedAllowed'], source, 'feePayer.hardcodedAllowed')) {
    throw new Error(`${source}: feePayer のハードコードは禁止。402 の extra.feePayer から取る`);
  }

  const rails = arr(root['rails'], source, 'rails').map((v, i) => {
    const o = obj(v, source, `rails[${i}]`);
    const domain = o['eip712Domain'];
    const rail: RailConfig = {
      id: str(o['id'], source, `rails[${i}].id`),
      chainKind: oneOf(o['chainKind'], ['solana', 'evm'] as const, source, `rails[${i}].chainKind`),
      network: str(o['network'], source, `rails[${i}].network`),
      asset: str(o['asset'], source, `rails[${i}].asset`),
      assetLabel: str(o['assetLabel'], source, `rails[${i}].assetLabel`),
      decimals: num(o['decimals'], source, `rails[${i}].decimals`),
      payTo: str(o['payTo'], source, `rails[${i}].payTo`),
      defaultAmount: str(o['defaultAmount'], source, `rails[${i}].defaultAmount`),
      confirmed: bool(o['confirmed'], source, `rails[${i}].confirmed`),
      verified: bool(o['verified'], source, `rails[${i}].verified`),
      requiresFeePayer: bool(o['requiresFeePayer'], source, `rails[${i}].requiresFeePayer`),
      networkV1: str(o['networkV1'], source, `rails[${i}].networkV1`),
      eip712Domain:
        domain === null
          ? null
          : {
              name: str(obj(domain, source, `rails[${i}].eip712Domain`)['name'], source, `rails[${i}].eip712Domain.name`),
              version: str(
                obj(domain, source, `rails[${i}].eip712Domain`)['version'],
                source,
                `rails[${i}].eip712Domain.version`,
              ),
              chainId:
                obj(domain, source, `rails[${i}].eip712Domain`)['chainId'] === undefined
                  ? null
                  : num(obj(domain, source, `rails[${i}].eip712Domain`)['chainId'], source, `rails[${i}].eip712Domain.chainId`),
              confirmed: bool(
                obj(domain, source, `rails[${i}].eip712Domain`)['confirmed'],
                source,
                `rails[${i}].eip712Domain.confirmed`,
              ),
            },
    };
    if (o['feePayer'] !== undefined) {
      throw new Error(`${source}: rails[${i}] に feePayer を持たせない（402 の extra.feePayer が正）`);
    }
    return rail;
  });

  return {
    version: str(root['version'], source, 'version'),
    protocol: {
      x402Version: num(protocol['x402Version'], source, 'protocol.x402Version'),
      scheme: str(protocol['scheme'], source, 'protocol.scheme'),
      requirementsHeader: str(protocol['requirementsHeader'], source, 'protocol.requirementsHeader'),
      paymentHeader: str(protocol['paymentHeader'], source, 'protocol.paymentHeader'),
      paymentResponseHeader: str(protocol['paymentResponseHeader'], source, 'protocol.paymentResponseHeader'),
      legAmountField: str(protocol['legAmountField'], source, 'protocol.legAmountField'),
      legAmountFieldV1: str(protocol['legAmountFieldV1'], source, 'protocol.legAmountFieldV1'),
      supportedPath: str(protocol['supportedPath'], source, 'protocol.supportedPath'),
      verifyPath: str(protocol['verifyPath'], source, 'protocol.verifyPath'),
      settlePath: str(protocol['settlePath'], source, 'protocol.settlePath'),
      maxTimeoutSeconds: num(protocol['maxTimeoutSeconds'], source, 'protocol.maxTimeoutSeconds'),
      mimeType: str(protocol['mimeType'], source, 'protocol.mimeType'),
      legExpiryField: str(protocol['legExpiryField'], source, 'protocol.legExpiryField'),
      legExpiryConfirmed: bool(protocol['legExpiryConfirmed'], source, 'protocol.legExpiryConfirmed'),
      confirmed: bool(protocol['confirmed'], source, 'protocol.confirmed'),
    },
    facilitator: {
      url: str(facilitator['url'], source, 'facilitator.url'),
      provider: str(facilitator['provider'], source, 'facilitator.provider'),
      confirmed: bool(facilitator['confirmed'], source, 'facilitator.confirmed'),
      verified: bool(facilitator['verified'], source, 'facilitator.verified'),
    },
    feePayer: {
      source: str(feePayer['source'], source, 'feePayer.source'),
      hardcodedAllowed: false,
      ttlMs: num(feePayer['ttlMs'], source, 'feePayer.ttlMs'),
    },
    rails,
    policy: {
      bridgingAllowed: bool(policy['bridgingAllowed'], source, 'policy.bridgingAllowed'),
      railSelection: str(policy['railSelection'], source, 'policy.railSelection'),
    },
  };
}
