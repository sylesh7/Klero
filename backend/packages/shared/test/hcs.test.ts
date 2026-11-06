import { describe, expect, it, vi } from 'vitest';
import { decodeAll, decodeHcs, encodeHcs, TopicFollower, waitForSeq } from '../src/hcs';
import { Mirror, type MirrorTopicMessage } from '../src/mirror';

const job = 'a'.repeat(64);
const human = 'b'.repeat(64);
const agent = '0x' + 'c'.repeat(40);

describe('hcs codec', () => {
  it('round-trips a CLAIM', () => {
    const msg = {
      v: 1 as const,
      t: 'CLAIM' as const,
      job,
      round: 0,
      human,
      agent,
      epoch: 1,
      svc: 'scribe-b',
      price: '40000',
    };
    const b64 = Buffer.from(encodeHcs(msg)).toString('base64');
    expect(decodeHcs(b64)).toEqual(msg);
  });

  it('still decodes legacy CLAIMs that carried an Arkiv key (field is stripped)', () => {
    const legacy = { v: 1, t: 'CLAIM', job, round: 0, human, agent, epoch: 1, svc: 'scribe-b', price: '40000', ak: '0x' + 'd'.repeat(64) };
    const decoded = decodeHcs(Buffer.from(JSON.stringify(legacy)).toString('base64'));
    expect(decoded?.t).toBe('CLAIM');
    expect(decoded && 'ak' in decoded).toBe(false);
  });

  it('round-trips a SERVICE announcement', () => {
    const msg = {
      v: 1 as const,
      t: 'SERVICE' as const,
      svc: 'scribe-a',
      cap: 'transcribe+summarize.v1',
      name: 'Scribe A',
      price: '50000',
      asset: '0.0.7',
      payTo: '0.0.8',
      url: 'http://localhost:4031/v1/jobs',
    };
    expect(decodeHcs(Buffer.from(encodeHcs(msg)).toString('base64'))).toEqual(msg);
  });

  it('rejects unknown shapes and non-JSON', () => {
    expect(decodeHcs(Buffer.from('{"v":1,"t":"NOPE"}').toString('base64'))).toBeNull();
    expect(decodeHcs(Buffer.from('not json').toString('base64'))).toBeNull();
  });

  it('rejects uppercase agent addresses (we always lowercase)', () => {
    expect(() => encodeHcs({ v: 1, t: 'LINK', human, agent: '0x' + 'C'.repeat(40), acct: '0.0.5', epoch: 1 })).toThrow();
  });

  it('accepts VOID with tx "none"', () => {
    const b64 = Buffer.from(encodeHcs({ v: 1, t: 'VOID', job, round: 2, tx: 'none' })).toString('base64');
    expect(decodeHcs(b64)?.t).toBe('VOID');
  });

  it('keeps every message under 1024 bytes', () => {
    const intent = encodeHcs({
      v: 1,
      t: 'INTENT',
      job,
      round: 999,
      agent,
      tx: '0.0.1234567@1793909236.461971198',
      dl: 1793909356,
      amt: '2000000',
      asset: '0.0.5001299',
      payTo: '0.0.5001302',
    });
    expect(intent.length).toBeLessThan(1024);
  });

  it('enforces the ICD-5 tx-id shape (9-digit nanos)', () => {
    const bad = { v: 1, t: 'SETTLED', job, round: 0, tx: '0.0.5@1700000000.5', cts: '1700000001.0' } as const;
    expect(() => encodeHcs(bad as never)).toThrow();
    const good = { v: 1, t: 'SETTLED', job, round: 0, tx: '0.0.5@1700000000.000000005', cts: '1700000001.0' } as const;
    expect(() => encodeHcs(good)).not.toThrow();
  });
});

// --- helpers for the mirror-backed tests ---
function row(seq: number, payload?: object): MirrorTopicMessage {
  return {
    consensus_timestamp: `17000000${String(seq).padStart(2, '0')}.000000000`,
    message: Buffer.from(JSON.stringify(payload ?? { v: 1, t: 'APPROVAL', human, kind: 'LINK', digest: 'f'.repeat(64) })).toString('base64'),
    payer_account_id: '0.0.5899352',
    running_hash: 'aa',
    running_hash_version: 3,
    sequence_number: seq,
    topic_id: '0.0.9999',
  };
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => row(a + i));
const page = (messages: MirrorTopicMessage[], next: string | null) =>
  new Response(JSON.stringify({ messages, links: { next } }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('decodeAll', () => {
  it('keeps undecodable messages visible as msg:null so audits can report them', () => {
    const junk: MirrorTopicMessage = { ...row(2), message: Buffer.from('garbage').toString('base64') };
    const out = decodeAll([row(1), junk]);
    expect(out[0]!.msg?.t).toBe('APPROVAL');
    expect(out[1]!.msg).toBeNull();
    expect(out[1]!.seq).toBe(2);
    expect(out[0]!.payer).toBe('0.0.5899352');
  });
});

describe('waitForSeq', () => {
  it('uses the single-message endpoint, not a topic walk (the gt:0 trap)', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      urls.push(new URL(u).pathname + new URL(u).search);
      return new Response(JSON.stringify(row(1)), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await waitForSeq(new Mirror('https://m.test'), '0.0.9999', 1);
    expect(urls).toEqual(['/api/v1/topics/0.0.9999/messages/1']);
    expect(urls[0]).not.toContain('sequencenumber');
    vi.unstubAllGlobals();
  });

  it('retries a 404 then succeeds', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () =>
      ++n === 1 ? new Response('', { status: 404 }) : new Response(JSON.stringify(row(3)), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await waitForSeq(new Mirror('https://m.test'), '0.0.9999', 3, 8000);
    expect(n).toBe(2);
    vi.unstubAllGlobals();
  });

  it('throws when the sequence never appears', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    await expect(waitForSeq(new Mirror('https://m.test'), '0.0.9999', 9, 1500)).rejects.toThrow(/not visible on Mirror Node/);
    vi.unstubAllGlobals();
  });
});

describe('TopicFollower', () => {
  it('accumulates in consensus order and reports only what is new', async () => {
    const pages = [page(range(1, 3), null), page(range(4, 5), null)];
    let i = 0;
    vi.stubGlobal('fetch', async () => pages[i++]!);
    const f = new TopicFollower(new Mirror('https://m.test'), '0.0.9999');

    const first = await f.sync();
    expect(first.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(f.latestSeq).toBe(3);

    const second = await f.sync();
    expect(second.map((d) => d.seq)).toEqual([4, 5]);
    expect(f.messages.map((d) => d.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(f.latestSeq).toBe(5);
    vi.unstubAllGlobals();
  });

  it('keeps progress when mirror fails mid-walk and resumes from lastSeq', async () => {
    let call = 0;
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => {
      urls.push(new URL(u).search);
      call++;
      if (call === 1) return page(range(1, 100), 'https://m.test/p2'); // slice 1, more to come
      if (call === 2) throw new Error('mirror blew up mid-walk');
      return page(range(101, 120), null); // retry after the failure
    });
    // attempts: 1 so the failure reaches the follower (by default Mirror retries transient errors itself)
    const f = new TopicFollower(new Mirror('https://m.test', { attempts: 1 }), '0.0.9999');

    await expect(f.sync()).rejects.toThrow(/blew up/);
    expect(f.latestSeq).toBe(100); // committed, not discarded
    expect(f.messages).toHaveLength(100);

    const fresh = await f.sync();
    expect(urls[2]).toContain('sequencenumber=gt:100'); // resumed, did NOT restart at 0
    expect(fresh.map((d) => d.seq)).toEqual(range(101, 120).map((r) => r.sequence_number));
    expect(f.latestSeq).toBe(120);
    vi.unstubAllGlobals();
  });

  it('shares one in-flight request between concurrent callers', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return page(range(1, 2), null);
    });
    const f = new TopicFollower(new Mirror('https://m.test'), '0.0.9999');
    const [a, b] = await Promise.all([f.sync(), f.sync()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(f.messages).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('syncThrough waits until our own seq is in', async () => {
    let call = 0;
    vi.stubGlobal('fetch', async () => (++call === 1 ? page([], null) : page(range(1, 4), null)));
    const f = new TopicFollower(new Mirror('https://m.test'), '0.0.9999');
    await f.syncThrough(4, 10_000);
    expect(f.latestSeq).toBeGreaterThanOrEqual(4);
    vi.unstubAllGlobals();
  });

  it('syncThrough gives up rather than hanging forever', async () => {
    vi.stubGlobal('fetch', async () => page([], null));
    const f = new TopicFollower(new Mirror('https://m.test'), '0.0.9999');
    await expect(f.syncThrough(5, 1500)).rejects.toThrow(/did not reach seq 5/);
    vi.unstubAllGlobals();
  });
});
