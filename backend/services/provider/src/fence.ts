import { buildLinks, getAgentLink, getClaim, viewJob } from '@forkos/shared';
import { arkivPub } from './arkiv';
import { env, OPERATOR_ID, PROVIDER_ACCOUNTS } from './config';
import { follower } from './hcs';

export type FenceInput = { jobKey: string; round: number; agent: string; claimKey: string };
export type FenceResult = { ok: true; epoch: number } | { ok: false; code: string; message: string };

export async function fence(i: FenceInput): Promise<FenceResult> {
  await follower.sync();
  const opts = { operatorId: OPERATOR_ID, providerAccounts: PROVIDER_ACCOUNTS };
  const view = viewJob(follower.messages, i.jobKey, opts);

  // F1, F2
  if (view.round !== i.round) return { ok: false, code: 'ROUND_CLOSED', message: `current round is ${view.round}` };
  if (view.status === 'PAID' || view.status === 'DONE' || view.status === 'REFUNDED') {
    return { ok: false, code: 'ROUND_CLOSED', message: `round already ${view.status}` };
  }
  // F3
  if (!view.winner || view.winner.agent !== i.agent) return { ok: false, code: 'NOT_WINNER', message: 'agent is not the HCS winner' };
  if (view.winner.arkivKey !== i.claimKey) return { ok: false, code: 'NOT_WINNER', message: 'claim key does not match the winning claim' };

  // F4
  const claim = await getClaim(arkivPub, i.claimKey);
  if (!claim) return { ok: false, code: 'NOT_WINNER', message: 'winning claim not live on Arkiv (expired?)' };
  if (claim.owner !== i.agent) return { ok: false, code: 'NOT_WINNER', message: 'claim not owned by the agent' };
  if (claim.job !== i.jobKey || claim.round !== i.round) return { ok: false, code: 'NOT_WINNER', message: 'claim is for another job/round' };
  if (claim.status !== 'WON' && claim.status !== 'PAYING') return { ok: false, code: 'NOT_WINNER', message: `claim status ${claim.status}` };

  // F5
  const link = buildLinks(follower.messages, opts).get(i.agent);
  if (!link || !link.active || link.epoch !== view.winner.epoch) {
    return { ok: false, code: 'STALE_AUTHORITY', message: 'agent revoked or epoch outdated (HCS)' };
  }
  // F6
  const live = await getAgentLink(arkivPub, i.agent, env.API_ARKIV_ADDRESS);
  if (!live || live.status !== 'ACTIVE' || live.epoch !== view.winner.epoch) {
    return { ok: false, code: 'STALE_AUTHORITY', message: 'agent link not ACTIVE at the current epoch (Arkiv)' };
  }
  return { ok: true, epoch: link.epoch };
}
