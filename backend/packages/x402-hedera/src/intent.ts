import { RESEND_CUTOFF_S, VALID_DURATION_S, VALID_START_BACKDATE_S, parsePrivateKey, txIdWithValidStart } from '@forkos/shared';
import { AccountId, Client, Hbar, PrivateKey, TokenId, TransferTransaction } from '@hiero-ledger/sdk';
import type { PaymentRequirements } from '@x402/core/types';
import type { ClientHederaSigner } from '@x402/hedera';

export type PaymentIntent = {
  txId: string; // SDK format, known before sending
  validStartMs: number;
  deadlineS: number; // unix seconds: the transaction is dead after this
  memo: string;
  transactionBase64: string; // signed by the payer, not yet by the fee payer
  requirements: PaymentRequirements;
};

export type IntentSignerOptions = {
  /** Paying account (holds the asset). */
  accountId: string;
  privateKey: PrivateKey | string;
  /** Written into the transaction memo (≤ 100 bytes). Use memoOf(jobKey, round). */
  memo: string;
  /**
   * Called with the fully built intent BEFORE the bytes are handed back to x402 (= before sending).
   * Persist it durably here. If this throws, nothing is sent.
   */
  persist: (intent: PaymentIntent) => Promise<void>;
  nowMs?: () => number;
};

export function deadlineOf(validStartMs: number): number {
  return Math.ceil((validStartMs + VALID_DURATION_S * 1000) / 1000);
}

/** True while it is still safe to resend the SAME bytes (never re-sign). */
export function canResend(deadlineS: number, nowMs = Date.now()): boolean {
  return nowMs / 1000 < deadlineS - RESEND_CUTOFF_S;
}

export function createIntentSigner(opts: IntentSignerOptions): ClientHederaSigner {
  const payer = AccountId.fromString(opts.accountId);
  const key = typeof opts.privateKey === 'string' ? parsePrivateKey(opts.privateKey) : opts.privateKey;
  if (Buffer.byteLength(opts.memo) > 100) throw new Error('memo exceeds 100 bytes');
  const now = opts.nowMs ?? Date.now;

  return {
    accountId: payer.toString(),
    async createPartiallySignedTransferTransaction(requirements: PaymentRequirements): Promise<string> {
      if (requirements.network !== 'hedera:testnet' && requirements.network !== 'hedera:mainnet') {
        throw new Error(`unsupported network ${requirements.network}`);
      }
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== 'string') throw new Error('feePayer missing in requirements.extra');
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error('amount must be > 0');
      const payTo = AccountId.fromString(requirements.payTo);

      const tx = new TransferTransaction();
      if (requirements.asset === '0.0.0') {
        tx.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
        tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const tokenId = TokenId.fromString(requirements.asset);
        tx.addTokenTransfer(tokenId, payer, -amount);
        tx.addTokenTransfer(tokenId, payTo, amount);
      }

      // The death clock: our own id (payer = facilitator fee payer, as the spec requires), explicit validity.
      const validStartMs = now() - VALID_START_BACKDATE_S * 1000;
      const txId = txIdWithValidStart(feePayer, validStartMs);
      tx.setTransactionId(txId);
      tx.setTransactionValidDuration(VALID_DURATION_S);
      tx.setTransactionMemo(opts.memo);

      const client = requirements.network === 'hedera:mainnet' ? Client.forMainnet() : Client.forTestnet();
      try {
        tx.freezeWith(client); // picks node account ids; no network call
        const signed = await tx.sign(key);
        const transactionBase64 = Buffer.from(signed.toBytes()).toString('base64');
        const intent: PaymentIntent = {
          txId: txId.toString(),
          validStartMs,
          deadlineS: deadlineOf(validStartMs),
          memo: opts.memo,
          transactionBase64,
          requirements,
        };
        await opts.persist(intent); // BEFORE returning → before x402 sends anything
        return transactionBase64;
      } finally {
        client.close();
      }
    },
  };
}
