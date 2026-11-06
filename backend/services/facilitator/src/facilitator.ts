import { parsePrivateKey, NETWORK } from '@forkos/shared';
import { x402Facilitator } from '@x402/core/facilitator';
import {
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  toFacilitatorHederaSigner,
} from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/facilitator';
import { env } from './env';
import { intentWindowProblem } from './guards';

const feePayerKey = parsePrivateKey(env.FACILITATOR_FEE_PAYER_KEY);

const signer = toFacilitatorHederaSigner({
  getAddresses: () => [env.FACILITATOR_FEE_PAYER_ID],
  // Adds our fee-payer signature, submits, and waits for a SUCCESS receipt (throws otherwise).
  signAndSubmitTransaction: createHederaSignAndSubmitTransaction((network) => createHederaClient(network), feePayerKey),
  // Checks the payer really signed, against the payer's on-chain key from Mirror Node.
  verifyPayerSignature: createHederaVerifyPayerSignature({ mirrorNodeUrl: env.MIRROR_URL }),
  // Checks payer balance and payTo association / auto-association capacity.
  preflightTransfer: createHederaPreflightTransfer({ mirrorNodeUrl: env.MIRROR_URL }),
});

export const facilitator = new x402Facilitator().register(
  NETWORK,
  new ExactHederaScheme(signer, { aliasPolicy: 'reject' }),
);

// ForkOS extra check #1 (verify time): refuse intents that are expired, about to expire, or longer-lived than 120 s.
facilitator.onBeforeVerify(async ({ paymentPayload }) => {
  const problem = intentWindowProblem(paymentPayload);
  if (problem) return { abort: true, reason: problem };
});
