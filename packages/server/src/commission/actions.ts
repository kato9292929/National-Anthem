import type { DisputeOutcome } from '@na/shared';
import type { PrivateGateway } from '../privacy/gateway.js';
import type { CommissionBoard } from './board.js';

/**
 * HTTP から commission board を動かす口。
 * 未知の action は握りつぶさず落とす。settle は封印精算（Gateway 経由）を必ず通す。
 */
export async function runCommissionAction(input: {
  board: CommissionBoard;
  gateway: PrivateGateway;
  localPlayerId: string;
  body: Record<string, unknown>;
}): Promise<unknown> {
  const { board, body } = input;
  const action = String(body['action'] ?? '');
  const id = (): string => String(body['commissionId'] ?? '');
  const str = (key: string, fallback = ''): string => String(body[key] ?? fallback);

  switch (action) {
    case 'open':
      return board.open({
        principalId: str('principalId', input.localPlayerId),
        itemId: str('itemId'),
        quantity: Number(body['quantity'] ?? 1),
        amount: str('amount'),
        legs: Array.isArray(body['legs'])
          ? (body['legs'] as { partnerId: string; note?: string }[])
          : [],
        note: str('note'),
      });
    case 'propose':
      return board.proposeAgent(id(), str('agentId'));
    case 'agree':
      return board.agree(id(), str('partyId', input.localPlayerId));
    case 'fund':
      return board.fund(id());
    case 'leg':
      return board.completeLeg(id(), Number(body['index'] ?? 0), str('result', 'done') as 'done' | 'failed', str('note'));
    case 'settle': {
      // 封印精算: 検証は MXE の中で走り、返るのは payment_valid だけ。
      const commission = board.get(id());
      if (!commission) throw new Error(`無い委託: ${id()}`);
      const verification = await input.gateway.verify({
        payload: { commissionId: commission.id, kind: 'commission-settlement' },
        leg: {
          scheme: 'native',
          network: 'internal',
          asset: 'internal',
          amount: commission.amount,
          legVersion: 2,
          payTo: 'internal',
        },
      });
      return board.settle(commission.id, { paymentValid: verification.payment_valid });
    }
    case 'refund':
      return board.refundForNonDelivery(id(), str('reason', 'non-delivery'));
    case 'dispute':
      return board.openDispute(id(), str('openedBy', input.localPlayerId), str('reason'));
    case 'resolve':
      return board.resolveDispute({
        disputeId: str('disputeId'),
        arbiterId: str('arbiterId'),
        outcome: str('outcome') as DisputeOutcome,
        resolution: str('resolution'),
        ...(body['paymentValid'] === undefined ? {} : { paymentValid: Boolean(body['paymentValid']) }),
      });
    default:
      throw new Error(`未知の commission action: ${action}`);
  }
}
