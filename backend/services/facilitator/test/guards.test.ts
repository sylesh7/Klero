import { Client, TransferTransaction } from '@hiero-ledger/sdk';
import { txIdWithValidStart } from '@forkos/shared';
import { describe, expect, it } from 'vitest';
import { decodeIntent, intentWindowProblem } from '../src/guards';

function payloadFor(validStartMs: number, duration = 120) {
  const tx = new TransferTransaction()
    .addHbarTransfer('0.0.1001', -5)
    .addHbarTransfer('0.0.1002', 5)
    .setTransactionId(txIdWithValidStart('0.0.900', validStartMs))
    .setTransactionValidDuration(duration)
    .setTransactionMemo('forkos:0123456789abcdef:r0');
  const client = Client.forTestnet();
  tx.freezeWith(client);
  client.close();
  const b64 = Buffer.from(tx.toBytes()).toString('base64');
  return { x402Version: 2, accepted: {} as never, payload: { transaction: b64 } };
}

describe('facilitator guards', () => {
  it('decodes tx id, valid start, duration and memo', () => {
    const now = 1_793_909_236_000;
    const d = decodeIntent(payloadFor(now));
    expect(d.txId).toBe('0.0.900@1793909236.000000000');
    expect(d.validStartMs).toBe(now);
    expect(d.durationS).toBe(120);
    expect(d.memo).toBe('forkos:0123456789abcdef:r0');
  });

  it('accepts a fresh intent, rejects expired / too long / future', () => {
    const now = Date.now();
    expect(intentWindowProblem(payloadFor(now - 5_000), now)).toBeNull();
    expect(intentWindowProblem(payloadFor(now - 119_000), now)).toBe('forkos_intent_expired');
    expect(intentWindowProblem(payloadFor(now - 5_000, 180), now)).toBe('forkos_valid_duration_too_long');
    expect(intentWindowProblem(payloadFor(now + 60_000), now)).toBe('forkos_valid_start_in_future');
    expect(intentWindowProblem({ x402Version: 2, accepted: {} as never, payload: { transaction: 'AA==' } }, now)).toBe(
      'forkos_undecodable_transaction',
    );
  });

  it('rejects at the 2 s pre-deadline cutoff, not after the deadline has passed', () => {
    const now = Date.now();
    // deadline = validStart + 120 s. 1 s of life left -> inside the 2 s guard -> rejected.
    expect(intentWindowProblem(payloadFor(now - 119_000), now)).toBe('forkos_intent_expired');
    // 5 s of life left -> still accepted
    expect(intentWindowProblem(payloadFor(now - 115_000), now)).toBeNull();
  });

  it('accepts a duration shorter than the cap but never longer', () => {
    const now = Date.now();
    expect(intentWindowProblem(payloadFor(now - 1_000, 60), now)).toBeNull();
    expect(intentWindowProblem(payloadFor(now - 1_000, 120), now)).toBeNull();
    expect(intentWindowProblem(payloadFor(now - 1_000, 121), now)).toBe('forkos_valid_duration_too_long');
  });
});
