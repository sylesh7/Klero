import { buildLinks, viewJob } from '@forkos/shared';
import { OPERATOR_ID, PROVIDER_ACCOUNTS } from './config';
import { follower } from './hcs';

export type FenceInput = { jobKey: string; round: number; agent: string };
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

  // F4
  const link = buildLinks(follower.messages, opts).get(i.agent);
  if (!link || !link.active || link.epoch !== view.winner.epoch) {
    return { ok: false, code: 'STALE_AUTHORITY', message: 'agent revoked or epoch outdated (HCS)' };
  }
  return { ok: true, epoch: link.epoch };
}
