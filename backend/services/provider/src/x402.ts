import { NETWORK } from '@forkos/shared';
import { Transaction } from '@hiero-ledger/sdk';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { extractTransactionFromPayload } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import type { FastifyReply } from 'fastify';
import { ENDPOINT, env } from './config';

export const facilitatorClient = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });

export const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactHederaScheme({
    defaultAssets: { [NETWORK]: { asset: env.PAY_ASSET, decimals: env.PAY_ASSET_DECIMALS } },
  }),
);

/** Must be awaited once at boot: fetches /supported so requirements get extra.feePayer. */
export async function initX402(): Promise<void> {
  await resourceServer.initialize();
}

export async function requirements(): Promise<PaymentRequirements[]> {
  return resourceServer.buildPaymentRequirementsFromOptions(
    [
      {
        scheme: 'exact',
        network: NETWORK,
        payTo: env.PROVIDER_ACCOUNT_ID,
        price: { asset: env.PAY_ASSET, amount: env.PROVIDER_PRICE },
        maxTimeoutSeconds: 180,
      },
    ],
    {},
  );
}

export async function send402(reply: FastifyReply, reqs: PaymentRequirements[], error?: string, extensions?: Record<string, unknown>) {
  const pr = await resourceServer.createPaymentRequiredResponse(
    reqs,
    {
      url: ENDPOINT,
      description: 'Transcribe and summarize one meeting recording',
      mimeType: 'application/json',
      serviceName: env.PROVIDER_NAME,
    },
    error,
    extensions,
  );
  return reply.code(402).header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(pr)).send(pr);
}

/** Transaction id of the payment inside an x402 payload (SDK format). */
export function txIdOfPayload(payload: PaymentPayload): string {
  const b64 = extractTransactionFromPayload(payload.payload as { transaction: string });
  const id = Transaction.fromBytes(Buffer.from(b64, 'base64')).transactionId;
  if (!id) throw new Error('payment transaction has no id');
  return id.toString();
}
