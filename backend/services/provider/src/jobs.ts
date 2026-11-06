import type { FastifyBaseLogger } from 'fastify';
import { sql, type JobRow } from './db';
import { fence } from './fence';
import { fetchAudio, transcribeAndSummarize } from './transcribe';

type Ctx = { jobKey: string; round: number; agent: string; chaosFail: boolean };

async function fail(id: string, error: string): Promise<JobRow> {
  const [row] = await sql<JobRow[]>`update prov_jobs set status = 'FAILED', error = ${error}, updated_at = now() where id = ${id} returning *`;
  return row!;
}

/** Called only after settlement succeeded. Executes at most once per (provider, job). */
export async function runJob(id: string, ctx: Ctx, log: FastifyBaseLogger): Promise<JobRow> {
  // Re-fence at the execution point (authority could have been revoked during settlement).
  // NOTE: the round is now PAID on Hedera but SETTLED is not on HCS yet, so the fence still sees PAYING.
  const f = await fence(ctx);
  if (!f.ok && f.code !== 'ROUND_CLOSED') return fail(id, `fence after settle: ${f.code} ${f.message}`);

  // PAYING → RUNNING; the partial unique index prov_jobs_one_exec forbids a second RUNNING/DONE for this job.
  try {
    const moved = await sql`update prov_jobs set status = 'RUNNING', updated_at = now() where id = ${id} and status = 'PAYING' returning id`;
    if (moved.length === 0) {
      const [row] = await sql<JobRow[]>`select * from prov_jobs where id = ${id}`;
      return row!;
    }
  } catch (err) {
    return fail(id, `already executed for this job: ${(err as Error).message}`);
  }

  const [row] = await sql<JobRow[]>`select * from prov_jobs where id = ${id}`;
  try {
    if (ctx.chaosFail) throw new Error('chaos: forced failure after payment');
    const audio = await fetchAudio(row!.audio_url, row!.input_hash);
    const out = await transcribeAndSummarize(audio);
    const [done] = await sql<JobRow[]>`
      update prov_jobs set status = 'DONE', transcript = ${out.transcript}, summary = ${out.summary},
             output_hash = ${out.outputHash}, updated_at = now()
       where id = ${id} returning *`;
    log.info({ id, outputHash: out.outputHash }, 'job done');
    return done!;
  } catch (err) {
    log.warn({ id, err: (err as Error).message }, 'job failed after payment');
    return fail(id, (err as Error).message);
  }
}
