import type { Decoded } from './hcs';

export type LinkState = { human: string; agent: string; acct: string; epoch: number; active: boolean };

export type ClaimView = {
  seq: number;
  cts: string;
  agent: string;
  human: string;
  epoch: number;
  svc: string;
  price: string;
  valid: boolean;
  reason: null | 'WRONG_ROUND' | 'NOT_LINKED' | 'REVOKED' | 'PAYER_MISMATCH' | 'WRONG_HUMAN' | 'STALE_EPOCH';
};

export type IntentView = {
  seq: number;
  cts: string;
  agent: string;
  tx: string;
  deadline: number;
  amount: string;
  asset: string;
  payTo: string;
};

export type JobStatus = 'OPEN' | 'CLAIMED' | 'PAYING' | 'PAID' | 'DONE' | 'REFUNDED';

export type JobView = {
  jobKey: string;
  round: number;
  status: JobStatus;
  winner: ClaimView | null;
  claims: ClaimView[];
  intent: IntentView | null;
  settled: { seq: number; tx: string; cts: string } | null;
  done: { seq: number; svc: string; out: string } | null;
  refund: { seq: number; tx: string; rtx: string; amount: string } | null;
  history: { round: number; tx: string; seq: number }[]; // closed (VOID) rounds
  lastSeq: number;
};

export type RefereeOptions = { operatorId: string; providerAccounts?: string[] };

function freshRound() {
  return {
    winner: null as ClaimView | null,
    claims: [] as ClaimView[],
    intent: null as IntentView | null,
    settled: null as JobView['settled'],
    done: null as JobView['done'],
    refund: null as JobView['refund'],
  };
}

function applyLink(links: Map<string, LinkState>, d: Decoded, opts: RefereeOptions): boolean {
  const m = d.msg;
  if (!m || d.payer !== opts.operatorId) return false;
  if (m.t === 'LINK') {
    links.set(m.agent, { human: m.human, agent: m.agent, acct: m.acct, epoch: m.epoch, active: true });
    return true;
  }
  if (m.t === 'REVOKE') {
    const cur = links.get(m.agent);
    if (cur) links.set(m.agent, { ...cur, epoch: m.epoch, active: false });
    return true;
  }
  return false;
}

/** Link state of every agent after processing messages up to and including `uptoSeq`. */
export function buildLinks(messages: Decoded[], opts: RefereeOptions, uptoSeq = Number.POSITIVE_INFINITY) {
  const links = new Map<string, LinkState>();
  for (const d of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (d.seq > uptoSeq) break;
    applyLink(links, d, opts);
  }
  return links;
}

export function viewJob(messages: Decoded[], jobKey: string, opts: RefereeOptions): JobView {
  const links = new Map<string, LinkState>();
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  let round = 0;
  let st = freshRound();
  // A provider can refund so quickly that its REFUND reaches consensus before the operator's SETTLED for the
  // same payment. Hold such a refund (it must still name this round's intent tx) and apply it only once the
  // matching SETTLED arrives, so a refund still never counts for a payment that did not settle.
  let earlyRefund: JobView['refund'] = null;
  const history: JobView['history'] = [];
  let lastSeq = 0;
  const isOp = (d: Decoded) => d.payer === opts.operatorId;

  for (const d of sorted) {
    lastSeq = d.seq;
    if (applyLink(links, d, opts)) continue;
    const m = d.msg;
    if (!m || !('job' in m) || m.job !== jobKey) continue;

    switch (m.t) {
      case 'CLAIM': {
        const link = links.get(m.agent);
        let reason: ClaimView['reason'] = null;
        if (m.round !== round) reason = 'WRONG_ROUND';
        else if (!link) reason = 'NOT_LINKED';
        else if (!link.active) reason = 'REVOKED';
        else if (link.acct !== d.payer) reason = 'PAYER_MISMATCH';
        else if (link.human !== m.human) reason = 'WRONG_HUMAN';
        else if (link.epoch !== m.epoch) reason = 'STALE_EPOCH';
        const view: ClaimView = {
          seq: d.seq,
          cts: d.cts,
          agent: m.agent,
          human: m.human,
          epoch: m.epoch,
          svc: m.svc,
          price: m.price,
          valid: reason === null,
          reason,
        };
        st.claims.push(view); // invalid ones too, so the dashboard and audit can show why
        if (view.valid && !st.winner) st.winner = view;
        break;
      }
      case 'INTENT': {
        if (isOp(d) && m.round === round && st.winner && m.agent === st.winner.agent && !st.intent) {
          st.intent = {
            seq: d.seq,
            cts: d.cts,
            agent: m.agent,
            tx: m.tx,
            deadline: m.dl,
            amount: m.amt,
            asset: m.asset,
            payTo: m.payTo,
          };
        }
        break;
      }
      case 'SETTLED': {
        if (isOp(d) && m.round === round && st.intent && m.tx === st.intent.tx && !st.settled) {
          st.settled = { seq: d.seq, tx: m.tx, cts: m.cts };
          if (earlyRefund && earlyRefund.tx === m.tx && !st.refund) st.refund = earlyRefund;
          earlyRefund = null;
        }
        break;
      }
      case 'DONE': {
        if (isOp(d) && m.round === round && st.settled && !st.done) st.done = { seq: d.seq, svc: m.svc, out: m.out };
        break;
      }
      case 'REFUND': {
        const trusted = !opts.providerAccounts || opts.providerAccounts.includes(d.payer);
        if (!trusted || m.round !== round || st.refund) break;
        const refund = { seq: d.seq, tx: m.tx, rtx: m.rtx, amount: m.amt };
        if (st.settled && m.tx === st.settled.tx) st.refund = refund;
        else if (!st.settled && st.intent && m.tx === st.intent.tx && !earlyRefund) earlyRefund = refund;
        break;
      }
      case 'VOID': {
        if (!isOp(d) || m.round !== round || st.settled) break;
        const closesIntent = st.intent !== null && m.tx === st.intent.tx;
        const closesAbandoned = st.intent === null && m.tx === 'none';
        if (closesIntent || closesAbandoned) {
          history.push({ round, tx: m.tx, seq: d.seq });
          round += 1;
          st = freshRound();
          earlyRefund = null;
        }
        break;
      }
      default:
        break;
    }
  }

  const status: JobStatus = st.refund
    ? 'REFUNDED'
    : st.done
      ? 'DONE'
      : st.settled
        ? 'PAID'
        : st.intent
          ? 'PAYING'
          : st.winner
            ? 'CLAIMED'
            : 'OPEN';

  return { jobKey, round, status, ...st, history, lastSeq };
}

/** Every jobKey mentioned on the topic (for the audit CLI). */
export function jobKeysIn(messages: Decoded[]): string[] {
  const set = new Set<string>();
  for (const d of messages) if (d.msg && 'job' in d.msg) set.add(d.msg.job);
  return [...set];
}
