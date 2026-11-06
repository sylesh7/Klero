import { describe, expect, it } from 'vitest';
import type { Decoded, HcsMessage } from '../src/hcs';
import { buildLinks, jobKeysIn, viewJob } from '../src/referee';

const OP = '0.0.100';
const PROV = '0.0.900';
const job = '1'.repeat(64);
const other = '9'.repeat(64);
const human = '2'.repeat(64);
const otherHuman = '3'.repeat(64);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const TX0 = '0.0.300@1793909236.000000000';
const TX1 = '0.0.300@1793909500.000000000';
const TX2 = '0.0.300@1793909900.000000000';

let seq = 0;
const at = (payer: string, msg: HcsMessage): Decoded => ({ seq: ++seq, payer, cts: `${1793909000 + seq}.0`, msg });
const link = (agent: string, acct: string, epoch = 1, h = human) =>
  at(OP, { v: 1, t: 'LINK', human: h, agent, acct, epoch });
const claim = (agent: string, payer: string, round = 0, epoch = 1, h = human, j = job) =>
  at(payer, { v: 1, t: 'CLAIM', job: j, round, human: h, agent, epoch, svc: 'scribe-a', price: '50000' });
const intent = (agent: string, tx: string, round = 0) =>
  at(OP, { v: 1, t: 'INTENT', job, round, agent, tx, dl: 1793909356, amt: '50000', asset: '0.0.7', payTo: '0.0.8' });
const settled = (tx: string, round = 0, payer = OP) =>
  at(payer, { v: 1, t: 'SETTLED', job, round, tx, cts: '1793909240.1' });
const opts = { operatorId: OP, providerAccounts: [PROV] };

describe('referee — the doc rules', () => {
  it('first valid claim wins; later claims lose', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), link(B, '0.0.202'), claim(B, '0.0.202'), claim(A, '0.0.201')];
    const v = viewJob(msgs, job, opts);
    expect(v.status).toBe('CLAIMED');
    expect(v.winner?.agent).toBe(B);
    expect(v.claims).toHaveLength(2);
  });

  it('rejects unlinked agents, payer mismatch, wrong human, stale epoch, revoked', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      link(B, '0.0.202', 1, otherHuman),
      claim(C, '0.0.203'),
      claim(A, '0.0.999'),
      claim(B, '0.0.202'),
      claim(A, '0.0.201', 0, 7),
      at(OP, { v: 1, t: 'REVOKE', human, agent: A, epoch: 2 }),
      claim(A, '0.0.201', 0, 2),
    ];
    const v = viewJob(msgs, job, opts);
    expect(v.winner).toBeNull();
    expect(v.claims.map((c) => c.reason)).toEqual(['NOT_LINKED', 'PAYER_MISMATCH', 'WRONG_HUMAN', 'STALE_EPOCH', 'REVOKED']);
    expect(v.status).toBe('OPEN');
  });

  it('ignores LINK not paid by the operator', () => {
    seq = 0;
    const fake = at('0.0.666', { v: 1, t: 'LINK', human, agent: C, acct: '0.0.203', epoch: 1 });
    expect(viewJob([fake, claim(C, '0.0.203')], job, opts).winner).toBeNull();
  });

  it('INTENT -> SETTLED -> DONE -> REFUND', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), settled(TX0)];
    expect(viewJob(msgs, job, opts).status).toBe('PAID');
    msgs.push(at(OP, { v: 1, t: 'DONE', job, round: 0, svc: 'scribe-a', out: 'f'.repeat(64) }));
    expect(viewJob(msgs, job, opts).status).toBe('DONE');
    msgs.push(at(PROV, { v: 1, t: 'REFUND', job, round: 0, tx: TX0, rtx: TX1, amt: '50000' }));
    expect(viewJob(msgs, job, opts).status).toBe('REFUNDED');
  });

  it('intent from a non-winner is ignored', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), link(B, '0.0.202'), claim(A, '0.0.201'), intent(B, TX0)];
    expect(viewJob(msgs, job, opts).intent).toBeNull();
  });

  it('VOID opens the next round; old-round claims become invalid', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      link(B, '0.0.202'),
      claim(A, '0.0.201'),
      intent(A, TX0),
      at(OP, { v: 1, t: 'VOID', job, round: 0, tx: TX0 }),
      claim(A, '0.0.201', 0),
      claim(B, '0.0.202', 1),
    ];
    const v = viewJob(msgs, job, opts);
    expect(v.round).toBe(1);
    expect(v.history).toEqual([{ round: 0, tx: TX0, seq: 5 }]);
    expect(v.winner?.agent).toBe(B);
    expect(v.claims[0]!.reason).toBe('WRONG_ROUND');
  });

  it('VOID none closes an abandoned round only when there is no intent', () => {
    seq = 0;
    const abandoned = [link(A, '0.0.201'), claim(A, '0.0.201'), at(OP, { v: 1, t: 'VOID', job, round: 0, tx: 'none' })];
    expect(viewJob(abandoned, job, opts).round).toBe(1);
    seq = 0;
    const withIntent = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), at(OP, { v: 1, t: 'VOID', job, round: 0, tx: 'none' })];
    expect(viewJob(withIntent, job, opts).round).toBe(0);
  });

  it('VOID after SETTLED is ignored (a paid round can never reopen)', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), settled(TX0), at(OP, { v: 1, t: 'VOID', job, round: 0, tx: TX0 })];
    const v = viewJob(msgs, job, opts);
    expect(v.round).toBe(0);
    expect(v.status).toBe('PAID');
  });
});

// Adversarial cases: these are what the chaos panel and the judges will try.
describe('referee — attacks on exactly-once', () => {
  it('is independent of delivery order (consensus seq is the only ordering)', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), link(B, '0.0.202'), claim(B, '0.0.202'), claim(A, '0.0.201'), intent(B, TX0), settled(TX0)];
    const inOrder = viewJob(msgs, job, opts);
    const shuffled = viewJob([...msgs].reverse(), job, opts);
    expect(shuffled.winner?.agent).toBe(inOrder.winner?.agent);
    expect(shuffled.status).toBe(inOrder.status);
    expect(shuffled.intent?.tx).toBe(inOrder.intent?.tx);
  });

  it('a second claim from the winner does not re-win or displace', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), claim(A, '0.0.201')];
    const v = viewJob(msgs, job, opts);
    expect(v.winner?.seq).toBe(2);
    expect(v.claims).toHaveLength(2);
  });

  it('only the FIRST intent of a round counts (a replayed INTENT cannot swap the tx id)', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), intent(A, TX1)];
    expect(viewJob(msgs, job, opts).intent?.tx).toBe(TX0);
  });

  it('SETTLED for a tx id that is not the intent is ignored', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), settled(TX2)];
    const v = viewJob(msgs, job, opts);
    expect(v.settled).toBeNull();
    expect(v.status).toBe('PAYING');
  });

  it('SETTLED not paid by the operator is ignored', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), settled(TX0, 0, '0.0.666')];
    expect(viewJob(msgs, job, opts).status).toBe('PAYING');
  });

  it('DONE without SETTLED is ignored', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), at(OP, { v: 1, t: 'DONE', job, round: 0, svc: 'scribe-a', out: 'f'.repeat(64) })];
    const v = viewJob(msgs, job, opts);
    expect(v.done).toBeNull();
    expect(v.status).toBe('PAYING');
  });

  it('REFUND that reaches consensus before SETTLED still counts once SETTLED arrives (seen live)', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), at(PROV, { v: 1, t: 'REFUND', job, round: 0, tx: TX0, rtx: TX1, amt: '50000' })];
    expect(viewJob(msgs, job, opts).status).toBe('PAYING'); // held, not applied: no SETTLED yet
    expect(viewJob(msgs, job, opts).refund).toBeNull();
    msgs.push(settled(TX0));
    const v = viewJob(msgs, job, opts);
    expect(v.status).toBe('REFUNDED');
    expect(v.refund?.rtx).toBe(TX1);
  });

  it('an early REFUND for a different tx is not applied when the real SETTLED arrives', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), at(PROV, { v: 1, t: 'REFUND', job, round: 0, tx: TX1, rtx: TX1, amt: '50000' }), settled(TX0)];
    const v = viewJob(msgs, job, opts);
    expect(v.refund).toBeNull();
    expect(v.status).toBe('PAID');
  });

  it('an early REFUND from an account that is not a known provider is ignored', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), at('0.0.666', { v: 1, t: 'REFUND', job, round: 0, tx: TX0, rtx: TX1, amt: '50000' }), settled(TX0)];
    const v = viewJob(msgs, job, opts);
    expect(v.refund).toBeNull();
    expect(v.status).toBe('PAID');
  });

  it('REFUND from an account that is not a known provider is ignored', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), settled(TX0), at('0.0.666', { v: 1, t: 'REFUND', job, round: 0, tx: TX0, rtx: TX1, amt: '50000' })];
    const v = viewJob(msgs, job, opts);
    expect(v.refund).toBeNull();
    expect(v.status).toBe('PAID');
  });

  it('VOID from a non-operator cannot reopen a round', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), at('0.0.666', { v: 1, t: 'VOID', job, round: 0, tx: TX0 })];
    const v = viewJob(msgs, job, opts);
    expect(v.round).toBe(0);
    expect(v.status).toBe('PAYING');
  });

  it('a revived (revoked) agent cannot win the round that VOID opened', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      claim(A, '0.0.201'),
      at(OP, { v: 1, t: 'VOID', job, round: 0, tx: 'none' }),
      at(OP, { v: 1, t: 'REVOKE', human, agent: A, epoch: 2 }),
      claim(A, '0.0.201', 1, 1), // old epoch, now revoked
      claim(A, '0.0.201', 1, 2), // correct epoch but still revoked
    ];
    const v = viewJob(msgs, job, opts);
    expect(v.round).toBe(1);
    expect(v.winner).toBeNull();
    expect(v.claims.map((c) => c.reason)).toEqual(['REVOKED', 'REVOKED']);
  });

  it('a relinked agent with the new epoch can win again', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      at(OP, { v: 1, t: 'REVOKE', human, agent: A, epoch: 2 }),
      link(A, '0.0.201', 3),
      claim(A, '0.0.201', 0, 2), // stale epoch
      claim(A, '0.0.201', 0, 3), // current
    ];
    const v = viewJob(msgs, job, opts);
    expect(v.claims.map((c) => c.reason)).toEqual(['STALE_EPOCH', null]);
    expect(v.winner?.epoch).toBe(3);
  });

  it('messages for another job never affect this one', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201', 0, 1, human, other), claim(A, '0.0.201')];
    const v = viewJob(msgs, job, opts);
    expect(v.claims).toHaveLength(1);
    expect(v.winner?.seq).toBe(3);
  });

  it('undecodable messages are skipped without disturbing the round', () => {
    seq = 0;
    const junk: Decoded = { seq: ++seq, payer: OP, cts: '1.0', msg: null };
    const msgs = [junk, link(A, '0.0.201'), claim(A, '0.0.201')];
    expect(viewJob(msgs, job, opts).winner?.agent).toBe(A);
  });

  it('two VOID rounds in a row accumulate history and keep counting up', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      claim(A, '0.0.201'),
      intent(A, TX0),
      at(OP, { v: 1, t: 'VOID', job, round: 0, tx: TX0 }),
      claim(A, '0.0.201', 1),
      intent(A, TX1, 1),
      at(OP, { v: 1, t: 'VOID', job, round: 1, tx: TX1 }),
      claim(A, '0.0.201', 2),
    ];
    const v = viewJob(msgs, job, opts);
    expect(v.round).toBe(2);
    expect(v.history.map((h) => h.round)).toEqual([0, 1]);
    expect(v.status).toBe('CLAIMED');
  });
});

describe('referee — helpers', () => {
  it('buildLinks respects uptoSeq (authority as of a given sequence)', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), at(OP, { v: 1, t: 'REVOKE', human, agent: A, epoch: 2 })];
    expect(buildLinks(msgs, opts, 1).get(A)?.active).toBe(true);
    expect(buildLinks(msgs, opts).get(A)?.active).toBe(false);
  });

  it('jobKeysIn lists every job mentioned', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), claim(A, '0.0.201'), claim(A, '0.0.201', 0, 1, human, other)];
    expect(jobKeysIn(msgs).sort()).toEqual([job, other].sort());
  });
});
