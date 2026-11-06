import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createIntentSigner, type IntentSignerOptions, type PaymentIntent } from './intent';

export type BuiltPayment = { payload: PaymentPayload; intent: PaymentIntent };

/**
 * Builds the x402 PaymentPayload for `chosen` using the official x402 client + our intent signer.
 * The intent is persisted (opts.persist) before this resolves.
 */
export async function buildIntentPayment(
  paymentRequired: PaymentRequired,
  chosen: PaymentRequirements,
  opts: Omit<IntentSignerOptions, 'persist'> & { persist: (i: PaymentIntent) => Promise<void> },
): Promise<BuiltPayment> {
  let captured: PaymentIntent | null = null;
  const signer = createIntentSigner({
    ...opts,
    persist: async (i) => {
      captured = i;
      await opts.persist(i);
    },
  });
  const client = new x402Client((_v, accepts) => {
    const match = accepts.find(
      (a) =>
        a.scheme === chosen.scheme &&
        a.network === chosen.network &&
        a.asset === chosen.asset &&
        a.amount === chosen.amount &&
        a.payTo === chosen.payTo,
    );
    if (!match) throw new Error('chosen payment requirement not offered by the server');
    return match;
  })
    .register('hedera:*', new ExactHederaScheme(signer))
    .setSpendControls(false); // ForkOS policy (P28) enforces limits; x402 defaults would reject FUSD and cap at $1

  const payload = await client.createPaymentPayload(paymentRequired);
  if (!captured) throw new Error('intent was not persisted');
  return { payload, intent: captured };
}

/** Picks the requirement for our network + asset (cheapest if several). */
export function pickRequirement(paymentRequired: PaymentRequired, network: string, asset: string): PaymentRequirements {
  const options = paymentRequired.accepts
    .filter((a) => a.scheme === 'exact' && a.network === network && a.asset === asset)
    .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  const first = options[0];
  if (!first) throw new Error(`server offers no exact ${network} option in asset ${asset}`);
  return first;
}
