import { Mirror, VOID_MARGIN_S, jobKeysIn, jobShort, readTopic, viewJob, type Decoded } from '@forkos/shared';

type Check = { job: string; check: string; ok: boolean; detail: string };

export async function audit(opts: { topic: string; operator: string; providers: string[]; mirrorUrl?: string; job?: string }) {
  const mirror = new Mirror(opts.mirrorUrl);
  const messages: Decoded[] = await readTopic(mirror, opts.topic);
  const jobs = opts.job ? [opts.job] : jobKeysIn(messages);
  const checks: Check[] = [];
  const nowS = Date.now() / 1000;

  for (const job of jobs) {
    const view = viewJob(messages, job, { operatorId: opts.operator, providerAccounts: opts.providers });
    const forJob = messages.filter((d) => d.msg && 'job' in d.msg && d.msg.job === job && d.payer === opts.operator);
    const settled = forJob.filter((d) => d.msg!.t === 'SETTLED');
    const intents = forJob.filter((d) => d.msg!.t === 'INTENT');
    checks.push({ job, check: 'A1 one payment', ok: settled.length <= 1, detail: `${settled.length} SETTLED` });

    for (const s of settled) {
      const m = s.msg as Extract<NonNullable<Decoded['msg']>, { t: 'SETTLED' }>;
      const intent = intents.map((d) => d.msg as Extract<NonNullable<Decoded['msg']>, { t: 'INTENT' }>).find((i) => i.tx === m.tx);
      const tx = await mirror.getTransaction(m.tx);
      const memoOk = tx.found && tx.memo === `forkos:${jobShort(job)}:r${m.round}`;
      const leg = tx.found ? (tx.tx.token_transfers ?? []).find((t) => t.account === intent?.payTo && t.amount > 0) : undefined;
      const ok = tx.found && tx.success && memoOk && !!intent && !!leg && String(leg.amount) === intent.amt;
      checks.push({ job, check: 'A2 settled is real', ok, detail: `${m.tx} ${tx.found ? tx.result : 'NOT FOUND'} memo=${memoOk}` });
    }

    for (const d of forJob.filter((x) => x.msg!.t === 'VOID')) {
      const m = d.msg as Extract<NonNullable<Decoded['msg']>, { t: 'VOID' }>;
      if (m.tx === 'none') {
        checks.push({ job, check: 'A3 void proven', ok: !intents.some((i) => (i.msg as { round: number }).round === m.round), detail: `round ${m.round} abandoned` });
        continue;
      }
      const intent = intents.map((x) => x.msg as Extract<NonNullable<Decoded['msg']>, { t: 'INTENT' }>).find((i) => i.tx === m.tx);
      const tx = await mirror.getTransaction(m.tx);
      const ok = (!tx.found || !tx.success) && !!intent && nowS > intent.dl + VOID_MARGIN_S;
      checks.push({ job, check: 'A3 void proven', ok, detail: `${m.tx} ${tx.found ? tx.result : 'not on ledger'}; deadline ${intent?.dl}` });
    }

    if (view.intent) checks.push({ job, check: 'A4 winner paid', ok: view.intent.agent === view.winner?.agent, detail: `winner ${view.winner?.agent}` });
    if (view.refund) {
      const r = await mirror.getTransaction(view.refund.rtx);
      checks.push({ job, check: 'A5 refund real', ok: r.found && r.success, detail: view.refund.rtx });
    }
  }
  return { jobs: jobs.length, checks, ok: checks.every((c) => c.ok) };
}
