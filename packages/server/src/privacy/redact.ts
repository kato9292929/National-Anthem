/**
 * ウォレットアドレスをログ / KV に残さないための検査。
 * 見つけたら黙って伏せ字にするのではなく、書き込み側を落とす（隠さない）。
 */

/** EVM: 0x + 40 hex。Solana: base58 32〜44 文字。mock: 前置きの仮アドレスも同じ扱い。 */
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'evm', re: /\b0x[a-fA-F0-9]{40}\b/ },
  { name: 'solana', re: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/ },
  { name: 'mock', re: /\bmock:[a-zA-Z0-9:]+\b/ },
];

export interface AddressHit {
  kind: string;
  path: string;
}

/** 値の中にアドレスらしき文字列があるか調べる。 */
export function findAddresses(value: unknown, path = '$'): AddressHit[] {
  if (typeof value === 'string') {
    return PATTERNS.filter((p) => p.re.test(value)).map((p) => ({ kind: p.name, path }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findAddresses(v, `${path}[${i}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, v]) => findAddresses(v, `${path}.${key}`));
  }
  return [];
}

export class AddressLeakError extends Error {
  override readonly name = 'AddressLeakError';
  constructor(readonly hits: AddressHit[], where: string) {
    super(
      `${where} にウォレットアドレスらしき値が含まれている: ` +
        hits.map((h) => `${h.path}(${h.kind})`).join(', '),
    );
  }
}

export function assertNoAddress(value: unknown, where: string): void {
  const hits = findAddresses(value);
  if (hits.length > 0) throw new AddressLeakError(hits, where);
}
