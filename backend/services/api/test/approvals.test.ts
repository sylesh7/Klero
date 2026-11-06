import { digestOf } from '@forkos/shared';
import { describe, expect, it } from 'vitest';

describe('approval digest binding', () => {
  const action = { kind: 'OVERCAP', human: 'a'.repeat(64), jobKey: 'b'.repeat(64), round: 0, providerId: 'scribe-premium', payTo: '0.0.9', amount: '2000000', asset: '0.0.7' };

  it('is stable under key order', () => {
    const shuffled = { amount: '2000000', asset: '0.0.7', round: 0, kind: 'OVERCAP', payTo: '0.0.9', providerId: 'scribe-premium', jobKey: 'b'.repeat(64), human: 'a'.repeat(64) };
    expect(digestOf(shuffled)).toBe(digestOf(action));
  });

  it('changes when any field changes (a replayed approval cannot authorize something else)', () => {
    expect(digestOf({ ...action, amount: '2000001' })).not.toBe(digestOf(action));
    expect(digestOf({ ...action, payTo: '0.0.10' })).not.toBe(digestOf(action));
    expect(digestOf({ ...action, round: 1 })).not.toBe(digestOf(action));
    expect(digestOf({ ...action, jobKey: 'c'.repeat(64) })).not.toBe(digestOf(action));
  });

  it('a REVOKE approval can never be replayed as an OVERCAP approval', () => {
    const revoke = { kind: 'REVOKE', human: 'a'.repeat(64), agent: '0x' + 'b'.repeat(40), fromEpoch: 1 };
    const overcap = { ...revoke, kind: 'OVERCAP' };
    expect(digestOf(revoke)).not.toBe(digestOf(overcap));
  });

  it('binds the epoch, so an approval to fire epoch 1 cannot fire epoch 2', () => {
    const e1 = { kind: 'REVOKE', human: 'a'.repeat(64), agent: '0x' + 'b'.repeat(40), fromEpoch: 1 };
    expect(digestOf({ ...e1, fromEpoch: 2 })).not.toBe(digestOf(e1));
  });
});
