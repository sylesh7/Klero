import { describe, expect, it } from 'vitest';
import { resolveIntent } from '../src/resolver';

const tx = '0.0.9@1793909231.000000000';
const deadline = 1793909351;
const notFound = { getTransaction: async () => ({ found: false as const }) };
const success = {
  getTransaction: async () => ({ found: true as const, success: true, result: 'SUCCESS', consensusTimestamp: '1793909240.1', memo: '', tx: {} as never }),
};
const failed = {
  getTransaction: async () => ({
    found: true as const,
    success: false,
    result: 'INSUFFICIENT_TOKEN_BALANCE',
    consensusTimestamp: '1793909240.1',
    memo: '',
    tx: {} as never,
  }),
};

describe('resolver (death clock)', () => {
  it('PAID whenever mirror has SUCCESS, even before the deadline', async () => {
    expect(await resolveIntent(success, tx, deadline, (deadline - 100) * 1000)).toEqual({
      state: 'PAID',
      consensusTimestamp: '1793909240.1',
    });
  });
  it('FAILED when consensus reached with a failure', async () => {
    expect((await resolveIntent(failed, tx, deadline, deadline * 1000)).state).toBe('FAILED');
  });
  it('UNKNOWN before deadline + 45 s, VOID after', async () => {
    expect((await resolveIntent(notFound, tx, deadline, (deadline + 44) * 1000)).state).toBe('UNKNOWN');
    expect((await resolveIntent(notFound, tx, deadline, (deadline + 46) * 1000)).state).toBe('VOID');
  });
});

describe('resolver — there is no third state', () => {
  it('a SUCCESS found long after the void margin is still PAID (mirror is the truth, not the clock)', async () => {
    expect((await resolveIntent(success, tx, deadline, (deadline + 10_000) * 1000)).state).toBe('PAID');
  });

  it('VOID is never returned while mirror knows the transaction', async () => {
    expect((await resolveIntent(failed, tx, deadline, (deadline + 999) * 1000)).state).toBe('FAILED');
  });

  it('exactly at deadline + 45 s it is still UNKNOWN; one second later it is VOID', async () => {
    expect((await resolveIntent(notFound, tx, deadline, (deadline + 45) * 1000)).state).toBe('UNKNOWN');
    expect((await resolveIntent(notFound, tx, deadline, (deadline + 45.001) * 1000)).state).toBe('VOID');
  });

  it('UNKNOWN backs off at most 5 s and at least 1 s, never past the void point', async () => {
    const far = await resolveIntent(notFound, tx, deadline, (deadline - 600) * 1000);
    expect(far.state === 'UNKNOWN' && far.retryAfterMs).toBe(5000);
    const near = await resolveIntent(notFound, tx, deadline, (deadline + 44.5) * 1000);
    expect(near.state === 'UNKNOWN' && near.retryAfterMs).toBeLessThanOrEqual(5000);
    expect(near.state === 'UNKNOWN' && near.retryAfterMs).toBeGreaterThanOrEqual(1000);
  });

  it('a transient mirror outage propagates rather than being mistaken for VOID', async () => {
    const broken = { getTransaction: async () => { throw new Error('mirror 503'); } };
    await expect(resolveIntent(broken, tx, deadline, (deadline + 999) * 1000)).rejects.toThrow('mirror 503');
  });
});
