import { clientFor, publishHcs } from '@forkos/shared';
import { Hbar, TransferTransaction } from '@hiero-ledger/sdk';
import type { FastifyBaseLogger } from 'fastify';
import { env } from './config';
import { sql, type JobRow } from './db';

const client = clientFor(env.PROVIDER_ACCOUNT_ID, env.PROVIDER_ACCOUNT_KEY);

/** Refund a FAILED job to the payer in the payment asset; idempotent (refund_tx_id set once). */
export async function refundJob(row: JobRow, log: Pick<FastifyBaseLogger, 'info' | 'error'>): Promise<JobRow> {
  if (row.status !== 'FAILED' || row.refund_tx_id) return row;
  if (!row.payer_account) {
    log.error({ id: row.id }, 'cannot refund: unknown payer');
    return row;
  }
  // Claim the refund first so two workers never refund twice.
  const claimed = await sql`update prov_jobs set refund_tx_id = 'PENDING', updated_at = now()
                             where id = ${row.id} and refund_tx_id is null returning id`;
  if (claimed.length === 0) return row;

  const amount = BigInt(row.amount);
  const tx = new TransferTransaction().setTransactionMemo(`forkos:refund:${row.job_key.slice(0, 16)}:r${row.round}`);
  if (env.PAY_ASSET === '0.0.0') {
    tx.addHbarTransfer(env.PROVIDER_ACCOUNT_ID, Hbar.fromTinybars((-amount).toString())).addHbarTransfer(
      row.payer_account,
      Hbar.fromTinybars(amount.toString()),
    );
  } else {
    tx.addTokenTransfer(env.PAY_ASSET, env.PROVIDER_ACCOUNT_ID, -amount).addTokenTransfer(env.PAY_ASSET, row.payer_account, amount);
  }
  try {
    const resp = await tx.execute(client);
    await resp.getReceipt(client);
    const refundTx = resp.transactionId.toString();
    await publishHcs(client, env.HCS_TOPIC_ID, {
      v: 1,
      t: 'REFUND',
      job: row.job_key,
      round: row.round,
      tx: row.payment_tx_id,
      rtx: refundTx,
      amt: row.amount.toString(),
    });
    const [updated] = await sql<JobRow[]>`update prov_jobs set status = 'REFUNDED', refund_tx_id = ${refundTx}, updated_at = now()
                                           where id = ${row.id} returning *`;
    log.info({ id: row.id, refundTx }, 'refunded');
    return updated!;
  } catch (err) {
    await sql`update prov_jobs set refund_tx_id = null, updated_at = now() where id = ${row.id}`;
    log.error({ id: row.id, err: (err as Error).message }, 'refund failed; will retry');
    return row;
  }
}
