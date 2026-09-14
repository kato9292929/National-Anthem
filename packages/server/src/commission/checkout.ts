import type { ReputationEvent, ReputationEventKind, Standing } from '@na/shared';
import type { IdentityService } from '../identity/service.js';
import type { PlayerLedger, LedgerState } from '../store/ledger.js';
import type { Checkout, CheckoutResult, CheckoutStep } from '../x402/demo-checkout.js';
import { GoodsStorefront, type PurchaseReceipt } from './storefront.js';

/**
 * 物販デモの一周を束ねる（区分A・mock）。
 * 見積り → 支払い可能かの事前確認 → x402 決済フロー → settle が通ったときだけ手持ち・評判を動かす。
 *
 * 手持ちと評判は「清算が通った」ときにだけ動く。402 を受けただけ・署名しただけでは動かさない。
 * 検証／清算が落ちたら失敗として返し、状態は一切動かさない（成功に見せない）。
 */

export class CheckoutError extends Error {
  override readonly name = 'CheckoutError';
}

export interface StorefrontCheckoutDeps {
  storefront: GoodsStorefront;
  ledger: PlayerLedger;
  identity: IdentityService;
  /** mock（DemoCheckout）でも実 testnet（TestnetCheckout）でも同じ形で受ける。 */
  checkout: Checkout;
  /** 買い手（払った側）に押す評判の種別。config 由来。 */
  settledReputationKind: ReputationEventKind;
}

export interface StorefrontCheckoutInput {
  buyerId: string;
  itemId: string;
  quantity: number;
  resource: string;
  /** スモーク専用の強制失敗（異常系を画面で見せる）。成功には決してしない。 */
  simulateFailure?: 'verify' | 'settle';
}

export interface StorefrontCheckoutOutcome {
  result: CheckoutResult;
  /** settle が通ったときだけ入る。 */
  receipt: PurchaseReceipt | null;
  ledger: LedgerState | null;
  standing: Standing | null;
  reputation: ReputationEvent | null;
}

export async function runStorefrontCheckout(
  deps: StorefrontCheckoutDeps,
  input: StorefrontCheckoutInput,
  onStep?: (step: CheckoutStep) => void,
): Promise<StorefrontCheckoutOutcome> {
  // 未知の買い手はここで落ちる。
  const buyer = deps.identity.identity(input.buyerId);
  const buyerKind: 'human' | 'agent' = buyer.kind === 'agent' ? 'agent' : 'human';

  // 値付けと在庫確認（副作用なし）。
  const quote = deps.storefront.quote({ itemId: input.itemId, quantity: input.quantity });

  // 払えないもの・持てないものは決済フローに入る前に落とす（買えないのに 402 を出さない）。
  const before = deps.ledger.state(input.buyerId);
  const amount = Number(quote.amount);
  if (amount > before.credits) {
    throw new CheckoutError(`credits 不足: 残高 ${before.credits} / 価格 ${amount}`);
  }
  if (before.held + quote.quantity > before.capacity) {
    throw new CheckoutError(`手持ち容量を超える: ${before.held}+${quote.quantity} > ${before.capacity}`);
  }

  const result = await deps.checkout.run(
    {
      resource: input.resource,
      description: `物販の購入: ${quote.label_ja} x${quote.quantity}`,
      amount: quote.amount,
      buyerKind,
      ...(input.simulateFailure ? { simulateFailure: input.simulateFailure } : {}),
    },
    onStep,
  );

  if (!result.ok) {
    // 失敗は失敗のまま返す。手持ち・評判は動かさない。
    return { result, receipt: null, ledger: null, standing: null, reputation: null };
  }

  // 清算が通った。ここで初めて手持ち・評判・記録を動かす。
  const ledger = deps.ledger.applyPurchase({
    buyerId: input.buyerId,
    itemId: quote.itemId,
    quantity: quote.quantity,
    amount: quote.amount,
  });
  const receipt = deps.storefront.recordSettled({ buyerId: input.buyerId, quote });
  const reputation = deps.identity.recordReputation({
    identityId: input.buyerId,
    kind: deps.settledReputationKind,
    ref: receipt.id,
    note: 'storefront settled (mock)',
  });
  const standing = deps.identity.standing(input.buyerId);
  return { result, receipt, ledger, standing, reputation };
}
