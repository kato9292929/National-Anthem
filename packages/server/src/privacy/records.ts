import type { EventLog } from '../store/event-log.js';
import { assertNoAddress } from './redact.js';

/**
 * 決済検証の記録。残すのは「検証が通ったか」だけ。
 * 送金元・金額・エンドポイントは記録しない（config recording.* が false）。
 * 書き込み時に検査し、混ざっていたら落とす。
 */

export interface PaymentRecord {
  id: string;
  at: number;
  payment_valid: boolean;
  /** 業務側の参照（commission id 等）。アドレスを入れてはいけない。 */
  ref: string | null;
}

export interface RecordingPolicy {
  walletAddressesAllowed: boolean;
  amountsAllowed: boolean;
  endpointsAllowed: boolean;
}

export class PaymentRecordStore {
  private counter = 0;

  constructor(
    private readonly log: EventLog,
    private readonly policy: RecordingPolicy,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(input: { payment_valid: boolean; ref?: string | null }): PaymentRecord {
    const ref = input.ref ?? null;
    if (ref !== null && !this.policy.walletAddressesAllowed) {
      assertNoAddress({ ref }, '決済記録の ref');
    }
    this.counter += 1;
    const record: PaymentRecord = {
      id: `pay-${String(this.counter).padStart(4, '0')}`,
      at: this.now(),
      payment_valid: input.payment_valid,
      ref,
    };
    assertNoAddress(record, '決済記録');
    this.log.append('payment_verified', record, record.at);
    return record;
  }

  all(): PaymentRecord[] {
    return this.log
      .readAll()
      .filter((e) => e.type === 'payment_verified')
      .map((e) => e.payload as PaymentRecord);
  }
}
