import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from './db';
import { facilitator } from './facilitator';
import { decodeIntent, intentWindowProblem } from './guards';

function fail(requirements: PaymentRequirements, reason: string, message: string, tx = ''): SettleResponse {
  return { success: false, errorReason: reason, errorMessage: message, transaction: tx, network: requirements.network };
}

export async function settleOnce(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  log: FastifyBaseLogger,
): Promise<SettleResponse> {
  let txId: string;
  try {
    txId = decodeIntent(paymentPayload).txId;
  } catch (err) {
    return fail(requirements, 'forkos_undecodable_transaction', (err as Error).message);
  }

  const windowProblem = intentWindowProblem(paymentPayload);
  if (windowProblem) return fail(requirements, windowProblem, 'intent outside its validity window', txId);

  // Claim the tx id. Returns a row only if we may attempt settlement now.
  const claimed = await sql<{ status: string; attempts: number }[]>`
    insert into fac_settlements (tx_id, status, pay_to, asset, amount)
    values (${txId}, 'SETTLING', ${requirements.payTo}, ${requirements.asset}, ${requirements.amount})
    on conflict (tx_id) do update
      set status = 'SETTLING', attempts = fac_settlements.attempts + 1, updated_at = now()
      where fac_settlements.status = 'FAILED'
    returning status, attempts`;
  if (claimed.length === 0) {
    const [existing] = await sql<{ status: string }[]>`select status from fac_settlements where tx_id = ${txId}`;
    log.warn({ txId, status: existing?.status }, 'replay rejected');
    return fail(requirements, 'forkos_replay_detected', `transaction already ${existing?.status ?? 'seen'}`, txId);
  }

  let result: SettleResponse;
  try {
    result = await facilitator.settle(paymentPayload, requirements);
  } catch (err) {
    result = fail(requirements, 'forkos_settle_error', (err as Error).message, txId);
  }

  await sql`
    update fac_settlements
       set status = ${result.success ? 'SETTLED' : 'FAILED'},
           last_error = ${result.success ? null : `${result.errorReason ?? ''} ${result.errorMessage ?? ''}`.trim()},
           settle_tx = ${result.transaction || null},
           updated_at = now()
     where tx_id = ${txId}`;
  log.info({ txId, success: result.success, reason: result.errorReason }, 'settle finished');
  return result;
}
