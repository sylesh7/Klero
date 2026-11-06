import { viewJob, type JobView } from '@forkos/shared';
import { REFEREE } from './config';
import { follower, services } from './clients';
import { sql, type IntentRow } from './db';

export async function jobView(jobKey: string): Promise<JobView> {
  await follower.sync();
  return viewJob(follower.messages, jobKey, REFEREE);
}

export function intentPublic(i: IntentRow) {
  return {
    intentId: i.id,
    jobKey: i.job_key,
    round: i.round,
    agentAddr: i.agent_addr,
    providerId: i.provider_id,
    payTo: i.pay_to,
    asset: i.asset,
    amount: i.amount,
    txId: i.tx_id,
    deadline: Number(i.deadline_s),
    status: i.status,
    attempts: i.attempts,
    consensusTimestamp: i.consensus_ts,
    lastError: i.last_error,
    result: i.result,
  };
}

export async function latestIntent(jobKey: string) {
  const [i] = await sql<IntentRow[]>`select * from intents where job_key = ${jobKey} order by round desc limit 1`;
  return i ?? null;
}

/** Service directory from HCS SERVICE announcements (registered provider accounts only). */
export async function directory() {
  return (await services()).map((s) => ({ ...s, price: s.price.toString() }));
}

export async function timeline(jobKey: string) {
  await follower.sync();
  return follower.messages
    .filter((d) => d.msg && (('job' in d.msg && d.msg.job === jobKey) || d.msg.t === 'LINK' || d.msg.t === 'REVOKE'))
    .map((d) => ({ seq: d.seq, cts: d.cts, payer: d.payer, ...d.msg! }));
}
