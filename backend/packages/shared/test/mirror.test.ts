import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mirror, type MirrorTopicMessage } from '../src/mirror';

const TOPIC = '0.0.9999';

function msg(seq: number): MirrorTopicMessage {
  return {
    consensus_timestamp: `17000000${String(seq).padStart(2, '0')}.000000000`,
    message: Buffer.from(`m${seq}`).toString('base64'),
    payer_account_id: '0.0.1234',
    running_hash: 'aa',
    running_hash_version: 3,
    sequence_number: seq,
    topic_id: TOPIC,
  };
}

/** Stub fetch with a queue of pages; records every URL path requested. */
function stubPages(pages: { messages: MirrorTopicMessage[]; next: string | null }[]) {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(new URL(url).pathname + new URL(url).search);
    const page = pages[i++];
    if (!page) throw new Error(`fetch called more times than pages provided (${i})`);
    return new Response(JSON.stringify({ messages: page.messages, links: { next: page.next } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return urls;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => msg(from + k));

afterEach(() => vi.unstubAllGlobals());

describe('Mirror.topicMessagesPage — sequencenumber filter (live-verified bug)', () => {
  it('omits the filter at afterSeq=0 (Mirror 400s on sequencenumber=gt:0)', async () => {
    const urls = stubPages([{ messages: range(1, 2), next: null }]);
    const r = await new Mirror('https://m.test').topicMessagesPage(TOPIC, 0);
    expect(urls[0]).not.toContain('sequencenumber');
    expect(urls[0]).toContain('order=asc');
    expect(urls[0]).toContain('limit=100');
    expect(r.messages.map((m) => m.sequence_number)).toEqual([1, 2]);
    expect(r.complete).toBe(true);
  });

  it('sends sequencenumber=gt:5 at afterSeq=5', async () => {
    const urls = stubPages([{ messages: range(6, 7), next: null }]);
    await new Mirror('https://m.test').topicMessagesPage(TOPIC, 5);
    expect(urls[0]).toContain('sequencenumber=gt:5');
  });

  it('negative afterSeq also omits the filter', async () => {
    const urls = stubPages([{ messages: range(1, 1), next: null }]);
    await new Mirror('https://m.test').topicMessagesPage(TOPIC, -1);
    expect(urls[0]).not.toContain('sequencenumber');
  });
});

describe('Mirror.topicMessagesPage — pagination', () => {
  it('follows next across pages and reports complete', async () => {
    stubPages([
      { messages: range(1, 100), next: 'https://m.test/api/v1/topics/x/messages?page=2' },
      { messages: range(101, 150), next: null },
    ]);
    const r = await new Mirror('https://m.test').topicMessagesPage(TOPIC, 0);
    expect(r.messages).toHaveLength(150);
    expect(r.complete).toBe(true);
    expect(r.messages[149]!.sequence_number).toBe(150);
  });

  it('drops page overlap rather than duplicating (next is a timestamp cursor)', async () => {
    stubPages([
      { messages: range(1, 100), next: 'https://m.test/next' },
      { messages: range(98, 120), next: null }, // 98..100 repeat
    ]);
    const r = await new Mirror('https://m.test').topicMessagesPage(TOPIC, 0);
    expect(r.messages.map((m) => m.sequence_number)).toEqual(range(1, 120).map((m) => m.sequence_number));
    expect(r.complete).toBe(true);
  });

  it('stops at maxPages with complete:false, and a second call finishes the walk', async () => {
    stubPages([{ messages: range(1, 100), next: 'https://m.test/next' }]);
    const m = new Mirror('https://m.test');
    const first = await m.topicMessagesPage(TOPIC, 0, 1);
    expect(first.messages).toHaveLength(100);
    expect(first.complete).toBe(false);

    const last = first.messages[first.messages.length - 1]!.sequence_number;
    const urls = stubPages([{ messages: range(101, 120), next: null }]);
    const second = await m.topicMessagesPage(TOPIC, last, 1);
    expect(urls[0]).toContain('sequencenumber=gt:100');
    expect(second.messages).toHaveLength(20);
    expect(second.complete).toBe(true);
  });

  it('treats 404 as the end of the topic', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    const r = await new Mirror('https://m.test').topicMessagesPage(TOPIC, 0);
    expect(r).toEqual({ messages: [], complete: true });
  });
});

describe('Mirror.topicMessagesPage — gap detection (a gap could pick the wrong winner)', () => {
  it('throws on a missing sequence number', async () => {
    stubPages([{ messages: [msg(1), msg(2), msg(4)], next: null }]);
    await expect(new Mirror('https://m.test').topicMessagesPage(TOPIC, 0)).rejects.toThrow(
      /Mirror gap on 0\.0\.9999: expected seq 3, got 4/,
    );
  });

  it('throws when the first message skips past afterSeq+1', async () => {
    stubPages([{ messages: [msg(9)], next: null }]);
    await expect(new Mirror('https://m.test').topicMessagesPage(TOPIC, 5)).rejects.toThrow(/expected seq 6, got 9/);
  });
});

describe('Mirror.topicMessages — resuming tail walk', () => {
  it('stitches slices and never restarts from 0', async () => {
    const urls = stubPages([
      { messages: range(1, 100), next: 'https://m.test/next' }, // slice 1 page 1 (maxPages=1 not used here)
      { messages: range(101, 130), next: null },
    ]);
    const all = await new Mirror('https://m.test').topicMessages(TOPIC, 0);
    expect(all).toHaveLength(130);
    expect(urls).toHaveLength(2);
  });

  it('throws instead of spinning when an incomplete slice returns nothing new', async () => {
    // one page, all overlap (seqs <= afterSeq), still advertising next, with maxPages exhausted
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ messages: [msg(3)], links: { next: 'https://m.test/next' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    // afterSeq=5 → msg(3) is overlap → 0 new, and next is always present → would spin forever
    await expect(new Mirror('https://m.test').topicMessages(TOPIC, 5)).rejects.toThrow(/stalled/);
  });
});

describe('Mirror.topicMessage — single message endpoint (no filter, no walk)', () => {
  it('hits /messages/:seq and returns the message', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(new URL(url).pathname);
      return new Response(JSON.stringify(msg(1)), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const got = await new Mirror('https://m.test').topicMessage(TOPIC, 1);
    expect(urls[0]).toBe(`/api/v1/topics/${TOPIC}/messages/1`);
    expect(got?.sequence_number).toBe(1);
  });

  it('returns null on 404 so callers can retry', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    expect(await new Mirror('https://m.test').topicMessage(TOPIC, 7)).toBeNull();
  });
});

describe('Mirror.getTransaction', () => {
  it('found:false for an unknown tx id (the VOID proof rests on this)', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    expect(await new Mirror('https://m.test').getTransaction('0.0.9@1700000000.000000001')).toEqual({ found: false });
  });

  it('prefers the nonce-0 unscheduled SUCCESS row and decodes the memo', async () => {
    const body = {
      transactions: [
        { transaction_id: '0.0.9-1700000000-000000001', consensus_timestamp: '1700000001.0', result: 'DUPLICATE_TRANSACTION', name: 'CRYPTOTRANSFER', memo_base64: '', scheduled: false, nonce: 0, valid_start_timestamp: '1700000000.000000001', charged_tx_fee: 1, transfers: [] },
        { transaction_id: '0.0.9-1700000000-000000001', consensus_timestamp: '1700000002.0', result: 'SUCCESS', name: 'CRYPTOTRANSFER', memo_base64: Buffer.from('forkos:11f22571df7398b5:r0').toString('base64'), scheduled: false, nonce: 0, valid_start_timestamp: '1700000000.000000001', charged_tx_fee: 1, transfers: [] },
      ],
    };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await new Mirror('https://m.test').getTransaction('0.0.9@1700000000.000000001');
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.success).toBe(true);
    expect(r.result).toBe('SUCCESS');
    expect(r.memo).toBe('forkos:11f22571df7398b5:r0');
  });

  it('found with success:false when the only row failed (money did not move)', async () => {
    const body = {
      transactions: [
        { transaction_id: '0.0.9-1700000000-000000001', consensus_timestamp: '1700000001.0', result: 'INSUFFICIENT_TOKEN_BALANCE', name: 'CRYPTOTRANSFER', memo_base64: '', scheduled: false, nonce: 0, valid_start_timestamp: '1700000000.000000001', charged_tx_fee: 1, transfers: [] },
      ],
    };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = await new Mirror('https://m.test').getTransaction('0.0.9@1700000000.000000001');
    expect(r.found && r.success).toBe(false);
    expect(r.found && r.result).toBe('INSUFFICIENT_TOKEN_BALANCE');
  });
});

describe('Mirror — timeouts and retries (a stalled connection used to hang for 300 s)', () => {
  const okTx = () =>
    new Response(JSON.stringify({ transactions: [{ result: 'SUCCESS', consensus_timestamp: '1.2', nonce: 0, scheduled: false }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const fast = { timeoutMs: 50, attempts: 3, retryDelayMs: 1 };

  it('retries a network error and then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      if (++calls === 1) throw new TypeError('fetch failed');
      return okTx();
    });
    const r = await new Mirror('https://m.test', fast).getTransaction('0.0.9@1.000000001');
    expect(r.found).toBe(true);
    expect(calls).toBe(2);
  });

  it('aborts a stalled request after timeoutMs and retries it', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', (_u: string, init?: { signal?: AbortSignal }) => {
      if (++calls === 1)
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)));
      return Promise.resolve(okTx());
    });
    const r = await new Mirror('https://m.test', fast).getTransaction('0.0.9@1.000000001');
    expect(r.found).toBe(true);
    expect(calls).toBe(2);
  });

  it('retries a 5xx, and gives up after the last attempt', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('upstream down', { status: 503 });
    });
    await expect(new Mirror('https://m.test', fast).getTransaction('0.0.9@1.000000001')).rejects.toThrow(/Mirror 503/);
    expect(calls).toBe(3);
  });

  it('never retries a 404: it is an answer (the VOID proof rests on it)', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{}', { status: 404 });
    });
    expect((await new Mirror('https://m.test', fast).getTransaction('0.0.9@1.000000001')).found).toBe(false);
    expect(calls).toBe(1);
  });

  it('never retries a 400', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('bad', { status: 400 });
    });
    await expect(new Mirror('https://m.test', fast).getTransaction('0.0.9@1.000000001')).rejects.toThrow(/Mirror 400/);
    expect(calls).toBe(1);
  });
});
