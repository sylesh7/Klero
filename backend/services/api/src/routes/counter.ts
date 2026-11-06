import { ApiError, jobShort, parseMemo, type MirrorTransaction } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mirror } from '../clients';
import { dep, env, PROVIDER_ACCOUNTS } from '../config';
import { sql } from '../db';

function paidToProvider(t: MirrorTransaction, from: string): { to: string; amount: string } | null {
  if (t.result !== 'SUCCESS') return null;
  const legs = (t.token_transfers ?? []).filter((x) => x.token_id === env.PAY_ASSET);
  const out = legs.find((x) => x.account === from && x.amount < 0);
  const inn = legs.find((x) => PROVIDER_ACCOUNTS.includes(x.account) && x.amount > 0);
  return out && inn ? { to: inn.account, amount: String(inn.amount) } : null;
}

export function registerCounterRoutes(app: FastifyInstance) {
  app.get('/v1/counter', async (req) => {
    const q = z.object({ jobKey: z.string().regex(/^[0-9a-f]{64}$/), since: z.coerce.number().optional() }).parse(req.query);
    const [owner] = await sql<{ budget_account_id: string }[]>`
      select h.budget_account_id from intents i join humans h on h.human_hash = i.human_hash where i.job_key = ${q.jobKey} limit 1`;

    const forkosTxs: { txId: string; cts: string; to: string; amount: string }[] = [];
    if (owner) {
      for (const t of await mirror.accountTransfers(owner.budget_account_id, 100)) {
        const memo = t.memo_base64 ? Buffer.from(t.memo_base64, 'base64').toString('utf8') : '';
        const m = parseMemo(memo);
        const leg = paidToProvider(t, owner.budget_account_id);
        if (m && m.jobShort === jobShort(q.jobKey) && leg) forkosTxs.push({ txId: t.transaction_id, cts: t.consensus_timestamp, ...leg });
      }
    }

    const sinceS = q.since ?? 0;
    const baselineTxs: typeof forkosTxs = [];
    for (const acct of dep.baselineAgents) {
      for (const t of await mirror.accountTransfers(acct, 50)) {
        if (Number(t.consensus_timestamp.split('.')[0]) < sinceS) continue;
        const leg = paidToProvider(t, acct);
        if (leg) baselineTxs.push({ txId: t.transaction_id, cts: t.consensus_timestamp, ...leg });
      }
    }
    if (!owner && !q.since) throw new ApiError('NOT_FOUND', 'no ForkOS intent for this job yet; pass ?since= for the baseline lane');
    return {
      jobKey: q.jobKey,
      source: 'mirror',
      forkos: { payments: forkosTxs.length, txs: forkosTxs },
      baseline: { payments: baselineTxs.length, txs: baselineTxs },
    };
  });
}
