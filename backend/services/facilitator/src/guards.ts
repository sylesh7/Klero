import { VALID_DURATION_S } from '@forkos/shared';
import { Transaction } from '@hiero-ledger/sdk';
import type { PaymentPayload } from '@x402/core/types';
import { extractTransactionFromPayload } from '@x402/hedera';

export type DecodedIntent = { txId: string; validStartMs: number; durationS: number; memo: string };

export function decodeIntent(paymentPayload: PaymentPayload): DecodedIntent {
  const b64 = extractTransactionFromPayload(paymentPayload.payload as { transaction: string });
  const tx = Transaction.fromBytes(Buffer.from(b64, 'base64'));
  const id = tx.transactionId;
  if (!id || !id.validStart) throw new Error('transaction has no transaction id / valid start');
  const validStartMs = Number(id.validStart.seconds.toString()) * 1000 + Math.floor(Number(id.validStart.nanos.toString()) / 1e6);
  return { txId: id.toString(), validStartMs, durationS: tx.transactionValidDuration, memo: tx.transactionMemo };
}

/** Returns an invalid-reason string, or null when the intent window is fine. */
export function intentWindowProblem(paymentPayload: PaymentPayload, nowMs = Date.now()): string | null {
  let d: DecodedIntent;
  try {
    d = decodeIntent(paymentPayload);
  } catch {
    return 'forkos_undecodable_transaction';
  }
  if (d.durationS > VALID_DURATION_S) return 'forkos_valid_duration_too_long';
  const deadlineMs = d.validStartMs + d.durationS * 1000;
  if (nowMs > deadlineMs - 2_000) return 'forkos_intent_expired';
  if (d.validStartMs > nowMs + 10_000) return 'forkos_valid_start_in_future';
  return null;
}
