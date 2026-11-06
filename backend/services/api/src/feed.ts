import { type Decoded, viewJob } from '@forkos/shared';
import { REFEREE } from './config';
import { follower } from './clients';
import { emit } from './events';

/** Called by the topic follower with new messages. */
export async function onNewMessages(fresh: Decoded[]) {
  for (const d of fresh) {
    const m = d.msg;
    if (!m || m.t !== 'CLAIM') continue;
    await emit('claim.posted', { jobKey: m.job, round: m.round, agentAddr: m.agent, svc: m.svc, price: m.price, seq: d.seq });
    const view = viewJob(follower.messages, m.job, REFEREE);
    const me = view.claims.find((c) => c.seq === d.seq);
    if (me && view.winner && view.winner.seq === d.seq) {
      await emit('claim.won', { jobKey: m.job, round: m.round, agentAddr: m.agent, seq: d.seq });
    } else if (me) {
      await emit('claim.lost', { jobKey: m.job, round: m.round, agentAddr: m.agent, seq: d.seq, winnerSeq: view.winner?.seq ?? null, reason: me.reason });
    }
  }
}
