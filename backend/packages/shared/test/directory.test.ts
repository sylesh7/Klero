import { describe, expect, it } from 'vitest';
import { directoryFrom } from '../src/directory';
import type { Decoded, HcsMessage } from '../src/hcs';

const CAP = 'transcribe+summarize.v1';
const providers = { 'scribe-a': '0.0.101', 'scribe-b': '0.0.102' };
let seq = 0;
const svc = (payer: string, over: Partial<Extract<HcsMessage, { t: 'SERVICE' }>> = {}): Decoded => ({
  seq: ++seq,
  payer,
  cts: `${1793909000 + seq}.0`,
  msg: {
    v: 1,
    t: 'SERVICE',
    svc: 'scribe-a',
    cap: CAP,
    name: 'Scribe A',
    price: '50000',
    asset: '0.0.7',
    payTo: '0.0.101',
    url: 'http://localhost:4031/v1/jobs',
    ...over,
  },
});

describe('directoryFrom — HCS service directory', () => {
  it('lists a service announced by its registered provider account', () => {
    seq = 0;
    const rows = directoryFrom([svc('0.0.101')], providers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerId: 'scribe-a', price: 50000n, payTo: '0.0.101', endpoint: 'http://localhost:4031/v1/jobs', seq: 1 });
  });

  it('ignores a fake "scribe-a" announced by someone else (spoofing)', () => {
    seq = 0;
    expect(directoryFrom([svc('0.0.666', { payTo: '0.0.666', url: 'http://evil.test/v1/jobs' })], providers)).toEqual([]);
  });

  it('ignores an announcement by the right account that pays out elsewhere', () => {
    seq = 0;
    expect(directoryFrom([svc('0.0.101', { payTo: '0.0.666' })], providers)).toEqual([]);
  });

  it('ignores unregistered provider ids and other capabilities', () => {
    seq = 0;
    expect(directoryFrom([svc('0.0.103', { svc: 'scribe-x', payTo: '0.0.103' }), svc('0.0.101', { cap: 'other.v1' })], providers)).toEqual([]);
  });

  it('the latest valid announcement wins; a later spoof cannot override it', () => {
    seq = 0;
    const rows = directoryFrom(
      [svc('0.0.101', { price: '50000' }), svc('0.0.101', { price: '45000' }), svc('0.0.666', { price: '1', payTo: '0.0.666' })],
      providers,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.price).toBe(45000n);
  });

  it('lists several providers, sorted by id', () => {
    seq = 0;
    const rows = directoryFrom([svc('0.0.102', { svc: 'scribe-b', name: 'Scribe B', payTo: '0.0.102', price: '40000' }), svc('0.0.101')], providers);
    expect(rows.map((r) => r.providerId)).toEqual(['scribe-a', 'scribe-b']);
  });
});
