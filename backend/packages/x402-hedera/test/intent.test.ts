import { PrivateKey, Transaction } from '@hiero-ledger/sdk';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { inspectHederaTransaction } from '@x402/hedera';
import { describe, expect, it } from 'vitest';
import { buildIntentPayment, canResend, createIntentSigner, deadlineOf, pickRequirement, type PaymentIntent } from '../src';

const key = PrivateKey.generateECDSA();
const req: PaymentRequirements = {
  scheme: 'exact',
  network: 'hedera:testnet',
  asset: '0.0.5001299',
  amount: '50000',
  payTo: '0.0.5001302',
  maxTimeoutSeconds: 180,
  extra: { feePayer: '0.0.5001300' },
};
const NOW = 1_793_909_236_000;

const signerFor = (over: Partial<Parameters<typeof createIntentSigner>[0]> = {}) =>
  createIntentSigner({
    accountId: '0.0.5001305',
    privateKey: key,
    memo: 'forkos:11f22571df7398b5:r0',
    nowMs: () => NOW,
    persist: async () => {},
    ...over,
  });

describe('intent signer', () => {
  it('builds a facilitator-valid transfer with our id, 120 s validity and memo, persisting first', async () => {
    const order: string[] = [];
    let saved: PaymentIntent | null = null;
    const signer = signerFor({
      persist: async (i) => {
        order.push('persist');
        saved = i;
      },
    });
    const b64 = await signer.createPartiallySignedTransferTransaction(req);
    order.push('returned');
    expect(order).toEqual(['persist', 'returned']);
    expect(saved!.txId).toBe('0.0.5001300@1793909231.000000000'); // NOW - 5 s, payer = fee payer
    expect(saved!.deadlineS).toBe(1793909231 + 120);
    expect(saved!.transactionBase64).toBe(b64);

    // Same inspection the reference facilitator runs in verify().
    const inspected = inspectHederaTransaction(b64);
    expect(inspected.transactionIdAccountId).toBe('0.0.5001300');
    expect(inspected.hasNonTransferOperations).toBe(false);
    const transfers = inspected.tokenTransfers['0.0.5001299']!;
    expect(transfers).toEqual(
      expect.arrayContaining([
        { accountId: '0.0.5001305', amount: '-50000' },
        { accountId: '0.0.5001302', amount: '50000' },
      ]),
    );
  });

  it('nothing is returned if persisting fails', async () => {
    const signer = signerFor({ memo: 'm', persist: async () => { throw new Error('db down'); } });
    await expect(signer.createPartiallySignedTransferTransaction(req)).rejects.toThrow('db down');
  });

  it('builds a full x402 PaymentPayload through the official client (FUSD not blocked)', async () => {
    const pr: PaymentRequired = { x402Version: 2, resource: { url: 'http://x/v1/jobs' }, accepts: [req] };
    const built = await buildIntentPayment(pr, req, {
      accountId: '0.0.5001305',
      privateKey: key,
      memo: 'forkos:11f22571df7398b5:r0',
      persist: async () => {},
    });
    expect(built.payload.x402Version).toBe(2);
    expect(built.payload.accepted).toEqual(req);
    expect((built.payload.payload as { transaction: string }).transaction).toBe(built.intent.transactionBase64);
  });

  it('resend window closes 10 s before the deadline', () => {
    expect(canResend(1000, 989_000)).toBe(true);
    expect(canResend(1000, 990_500)).toBe(false);
  });
});

// The death clock is the product. These pin the properties the whole guarantee rests on.
describe('intent signer — death clock properties', () => {
  it('the signed bytes carry exactly a 120 s validity, so the network kills them on time', async () => {
    const b64 = await signerFor().createPartiallySignedTransferTransaction(req);
    const tx = Transaction.fromBytes(Buffer.from(b64, 'base64'));
    expect(tx.transactionValidDuration).toBe(120);
    expect(tx.transactionId!.toString()).toBe('0.0.5001300@1793909231.000000000');
    expect(tx.transactionMemo).toBe('forkos:11f22571df7398b5:r0');
  });

  it('valid start is backdated 5 s, so clock skew cannot make it start in the future', async () => {
    let saved: PaymentIntent | null = null;
    await signerFor({ persist: async (i) => { saved = i; } }).createPartiallySignedTransferTransaction(req);
    expect(saved!.validStartMs).toBe(NOW - 5_000);
    expect(deadlineOf(saved!.validStartMs)).toBe(saved!.deadlineS);
  });

  it('the tx id is known BEFORE anything is sent — persist sees the final id and bytes', async () => {
    let seen: PaymentIntent | null = null;
    const b64 = await signerFor({ persist: async (i) => { seen = { ...i }; } }).createPartiallySignedTransferTransaction(req);
    expect(seen!.txId).toMatch(/^0\.0\.5001300@\d+\.\d{9}$/);
    expect(seen!.transactionBase64).toBe(b64); // the exact bytes a retry will resend
  });

  it('two intents built at the same instant collide on tx id (so a retry can never double-spend)', async () => {
    const a = await signerFor().createPartiallySignedTransferTransaction(req);
    const b = await signerFor().createPartiallySignedTransferTransaction(req);
    const idA = Transaction.fromBytes(Buffer.from(a, 'base64')).transactionId!.toString();
    const idB = Transaction.fromBytes(Buffer.from(b, 'base64')).transactionId!.toString();
    expect(idA).toBe(idB); // same frozen clock -> same id -> network DUPLICATE_TRANSACTION
  });

  it('falls back to a plain HBAR transfer when the asset is 0.0.0', async () => {
    const hbarReq = { ...req, asset: '0.0.0', amount: '500000000' };
    const b64 = await signerFor().createPartiallySignedTransferTransaction(hbarReq);
    const inspected = inspectHederaTransaction(b64);
    expect(Object.keys(inspected.tokenTransfers)).toHaveLength(0);
    expect(inspected.hbarTransfers).toEqual(
      expect.arrayContaining([
        { accountId: '0.0.5001305', amount: '-500000000' },
        { accountId: '0.0.5001302', amount: '500000000' },
      ]),
    );
  });

  it('refuses a memo over the 100-byte Hedera limit', () => {
    expect(() => signerFor({ memo: 'x'.repeat(101) })).toThrow(/memo exceeds 100 bytes/);
  });

  it('refuses a zero or negative amount, a missing feePayer and a foreign network', async () => {
    const s = signerFor();
    await expect(s.createPartiallySignedTransferTransaction({ ...req, amount: '0' })).rejects.toThrow(/amount must be > 0/);
    await expect(s.createPartiallySignedTransferTransaction({ ...req, extra: {} })).rejects.toThrow(/feePayer missing/);
    await expect(s.createPartiallySignedTransferTransaction({ ...req, network: 'eip155:84532' })).rejects.toThrow(/unsupported network/);
  });
});

describe('pickRequirement', () => {
  it('picks the cheapest matching exact option for our network and asset', () => {
    const pr: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'http://x' },
      accepts: [
        { ...req, amount: '90000' },
        { ...req, amount: '40000' },
        { ...req, network: 'eip155:84532', amount: '1' },
        { ...req, asset: '0.0.999', amount: '2' },
      ],
    };
    expect(pickRequirement(pr, 'hedera:testnet', '0.0.5001299').amount).toBe('40000');
  });

  it('throws when the server offers nothing we can pay', () => {
    const pr: PaymentRequired = { x402Version: 2, resource: { url: 'http://x' }, accepts: [{ ...req, asset: '0.0.999' }] };
    expect(() => pickRequirement(pr, 'hedera:testnet', '0.0.5001299')).toThrow(/offers no exact/);
  });
});
