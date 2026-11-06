import { WINNER_GRACE_S, hashscan, jobKeysIn, publishHcs } from '@forkos/shared';
import { canResend, resolveIntent } from '@forkos/x402-hedera';
import { follower, hedera, mirror } from './clients';
import { env } from './config';
import { sql, type IntentRow } from './db';
import { emit } from './events';
import { sendIntent } from './payer';
import { jobView } from './views';

async function publishSettled(r: IntentRow, cts: string) {
  await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'SETTLED', job: r.job_key, round: r.round, tx: r.tx_id, cts });
  await sql`update intents set consensus_ts = ${cts}, updated_at = now() where id = ${r.id}`;
  await emit('payment.paid', { intentId: r.id, txId: r.tx_id, consensusTimestamp: cts, hashscan: hashscan.tx(cts) });
}

async function publishDone(r: IntentRow) {
  const out = (r.result as { outputHash?: string } | null)?.outputHash;
  if (!out) return;
  await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'DONE', job: r.job_key, round: r.round, svc: r.provider_id, out });
}

/** Ask the provider for the result of a payment we know settled. */
async function fetchResult(r: IntentRow) {
  const base = r.endpoint.replace(/\/v1\/jobs$/, '');
  const res = await fetch(`${base}/v1/jobs/by-payment/${encodeURIComponent(r.tx_id)}`);
  if (!res.ok) return null;
  return (await res.json()) as { status: string; outputHash?: string; summary?: string; refundTxId?: string };
}

async function tickIntents() {
  // stale SENT (process died mid-request) → unknown
  await sql`update intents set status = 'PAYMENT_UNKNOWN', updated_at = now() where status = 'SENT' and updated_at < now() - interval '100 seconds'`;

  const open = await sql<IntentRow[]>`select * from intents where status in ('PAYMENT_UNKNOWN','REJECTED') order by created_at limit 20`;
  for (const r of open) {
    const st = await resolveIntent(mirror, r.tx_id, Number(r.deadline_s));
    if (st.state === 'PAID') {
      await sql`update intents set status = 'PAID', updated_at = now() where id = ${r.id}`;
      await publishSettled(r, st.consensusTimestamp);
      continue; // result fetched below in the PAID pass
    }
    if (st.state === 'FAILED' || st.state === 'VOID') {
      await sql`update intents set status = 'VOID', last_error = ${st.state === 'FAILED' ? st.result : 'proven void'}, updated_at = now() where id = ${r.id}`;
      await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'VOID', job: r.job_key, round: r.round, tx: r.tx_id });
      await emit('payment.void', { intentId: r.id, txId: r.tx_id, provedAt: new Date().toISOString() });
      continue;
    }
    // UNKNOWN: resend the SAME bytes once while it is still safe (never re-sign)
    if (r.status === 'PAYMENT_UNKNOWN' && r.attempts < 2 && canResend(Number(r.deadline_s))) await sendIntent(r);
  }

  // PAID / DONE / REFUNDED that still need SETTLED or DONE on HCS, or a result
  const paid = await sql<IntentRow[]>`select * from intents where status in ('PAID','DONE','REFUNDED') and (consensus_ts is null or (status = 'PAID')) limit 20`;
  for (const r of paid) {
    if (!r.consensus_ts) {
      const found = await mirror.getTransaction(r.tx_id);
      if (found.found && found.success) await publishSettled(r, found.consensusTimestamp);
      else continue;
    }
    if (r.status === 'PAID') {
      const result = await fetchResult(r);
      if (result?.status === 'DONE') {
        const [u] = await sql<IntentRow[]>`update intents set status = 'DONE', result = ${sql.json(result as never)}, updated_at = now() where id = ${r.id} returning *`;
        await publishDone(u!);
        await emit('job.done', { intentId: r.id, jobKey: r.job_key, outputHash: result.outputHash, summary: result.summary });
      } else if (result?.status === 'REFUNDED') {
        await sql`update intents set status = 'REFUNDED', result = ${sql.json(result as never)}, updated_at = now() where id = ${r.id}`;
        await emit('refund.sent', { jobKey: r.job_key, round: r.round, txId: r.tx_id, refundTxId: result.refundTxId });
      }
    } else if (r.status === 'DONE') {
      const view = await jobView(r.job_key);
      if (!view.done) await publishDone(r);
    }
  }
}

/** A winner that never produced an INTENT within WINNER_GRACE_S (and has no pending approval) → VOID none. */
async function tickAbandoned() {
  await follower.sync();
  const nowS = Date.now() / 1000;
  for (const jobKey of jobKeysIn(follower.messages)) {
    const view = await jobView(jobKey);
    if (view.status !== 'CLAIMED' || !view.winner) continue;
    const age = nowS - Number(view.winner.cts.split('.')[0]);
    if (age < WINNER_GRACE_S) continue;
    // The topic is shared by every deployment that holds the operator key. Only the backend this human signed in
    // to has their intents and over-cap approvals; any other one would wrongly see the round as abandoned and VOID
    // it while the human is still approving. So only close rounds for humans registered here.
    const [mine] = await sql`select 1 from humans where human_hash = ${view.winner.human}`;
    if (!mine) continue;
    const [intent] = await sql`select 1 from intents where job_key = ${jobKey} and round = ${view.round}`;
    if (intent) continue;
    const [pending] = await sql`select 1 from approvals where status in ('PENDING','APPROVED') and action->>'jobKey' = ${jobKey}
                                  and (action->>'round')::int = ${view.round} and expires_at > now()`;
    if (pending) continue;
    await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'VOID', job: jobKey, round: view.round, tx: 'none' });
    await emit('payment.void', { intentId: null, txId: 'none', provedAt: new Date().toISOString(), jobKey, round: view.round });
  }
}

export function startResolver(log: { error: (o: object, m: string) => void }) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tickIntents();
      await tickAbandoned();
    } catch (err) {
      log.error({ err }, 'resolver tick failed');
    } finally {
      busy = false;
    }
  }, 3000);
}
