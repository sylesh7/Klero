import { VALID_DURATION_S, VOID_MARGIN_S, validStartSecondsOf } from '@forkos/shared';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type JobRow } from './db';
import { mirror } from './hcs';
import { runJob } from './jobs';
import { refundJob } from './refunds';

/**
 * Every 15 s:
 *  - PAYING older than 20 s (crash between record and settle response): ask Mirror Node.
 *      PAID → run the job (or refund via FAILED).  FAILED/VOID → PAYMENT_FAILED.  Unknown → wait.
 *  - RUNNING older than 10 min (crash mid-job) → FAILED.
 *  - FAILED with no refund → refund.
 */
export function startReconciler(log: FastifyBaseLogger) {
  const tick = async () => {
    try {
      const paying = await sql<JobRow[]>`select * from prov_jobs where status = 'PAYING' and updated_at < now() - interval '20 seconds'`;
      for (const row of paying) {
        const found = await mirror.getTransaction(row.payment_tx_id);
        const deadline = validStartSecondsOf(row.payment_tx_id) + VALID_DURATION_S;
        if (found.found && found.success) {
          log.info({ id: row.id }, 'reconciler: payment settled, running job');
          const after = await runJob(row.id, { jobKey: row.job_key, round: row.round, agent: row.agent_addr, chaosFail: false }, log);
          if (after.status === 'FAILED') await refundJob(after, log);
        } else if ((found.found && !found.success) || Date.now() / 1000 > deadline + VOID_MARGIN_S) {
          await sql`update prov_jobs set status = 'PAYMENT_FAILED', error = 'payment did not settle (reconciler)', updated_at = now() where id = ${row.id}`;
        }
      }
      await sql`update prov_jobs set status = 'FAILED', error = coalesce(error, 'timed out while running'), updated_at = now()
                 where status = 'RUNNING' and updated_at < now() - interval '10 minutes'`;
      const failed = await sql<JobRow[]>`select * from prov_jobs where status = 'FAILED' and refund_tx_id is null`;
      for (const row of failed) await refundJob(row, log);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'reconciler tick failed');
    }
  };
  setInterval(tick, 15_000);
}
