import { Client, TopicMessageSubmitTransaction } from '@hiero-ledger/sdk';
import { z } from 'zod';
import { MIRROR_WAIT_TIMEOUT_MS } from './constants';
import { Mirror, type MirrorTopicMessage } from './mirror';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const addr = z.string().regex(/^0x[0-9a-f]{40}$/);
const hid = z.string().regex(/^0\.0\.\d+$/);
const sdkTx = z.string().regex(/^0\.0\.\d+@\d+\.\d{9}$/);
const round = z.number().int().nonnegative();
const units = z.string().regex(/^\d+$/);
const v = z.literal(1);

export const HcsMessage = z.discriminatedUnion('t', [
  z.object({ v, t: z.literal('LINK'), human: hex64, agent: addr, acct: hid, epoch: z.number().int().positive() }),
  z.object({ v, t: z.literal('REVOKE'), human: hex64, agent: addr, epoch: z.number().int().positive() }),
  z.object({
    v,
    t: z.literal('CLAIM'),
    job: hex64,
    round,
    human: hex64,
    agent: addr,
    epoch: z.number().int().positive(),
    svc: z.string().min(1).max(32),
    price: units,
    // (older CLAIMs also carried `ak`, an Arkiv claim key; zod strips it, so history still decodes)
  }),
  // Service directory entry, submitted by the provider's own account. Only trusted when the payer is the
  // provider account registered in deployments (see directory.ts) — so nobody can list a fake provider.
  z.object({
    v,
    t: z.literal('SERVICE'),
    svc: z.string().min(1).max(32),
    cap: z.string().min(1).max(64),
    name: z.string().min(1).max(64),
    price: units,
    asset: hid,
    payTo: hid,
    url: z.string().url().max(256),
  }),
  z.object({
    v,
    t: z.literal('INTENT'),
    job: hex64,
    round,
    agent: addr,
    tx: sdkTx,
    dl: z.number().int().positive(),
    amt: units,
    asset: hid,
    payTo: hid,
  }),
  z.object({ v, t: z.literal('SETTLED'), job: hex64, round, tx: sdkTx, cts: z.string().regex(/^\d+\.\d+$/) }),
  z.object({ v, t: z.literal('VOID'), job: hex64, round, tx: z.union([sdkTx, z.literal('none')]) }),
  z.object({ v, t: z.literal('DONE'), job: hex64, round, svc: z.string().min(1).max(32), out: hex64 }),
  z.object({ v, t: z.literal('REFUND'), job: hex64, round, tx: sdkTx, rtx: sdkTx, amt: units }),
  z.object({ v, t: z.literal('APPROVAL'), human: hex64, kind: z.enum(['LINK', 'REVOKE', 'OVERCAP']), digest: hex64 }),
]);
export type HcsMessage = z.infer<typeof HcsMessage>;

export type Decoded = {
  seq: number;
  payer: string;
  cts: string;
  msg: HcsMessage | null; // null = not valid JSON or not in schema (kept so the audit can report it)
};

export function encodeHcs(msg: HcsMessage): Uint8Array {
  const parsed = HcsMessage.parse(msg);
  const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
  if (bytes.length > 1024) throw new Error(`HCS message too large (${bytes.length} bytes > 1024)`);
  return bytes;
}

export function decodeHcs(base64: string): HcsMessage | null {
  try {
    const r = HcsMessage.safeParse(JSON.parse(Buffer.from(base64, 'base64').toString('utf8')));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Submits and waits for the receipt. The submitting client's operator is the message payer. */
export async function publishHcs(
  client: Client,
  topicId: string,
  msg: HcsMessage,
): Promise<{ seq: number; txId: string }> {
  const resp = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(encodeHcs(msg)).execute(client);
  const receipt = await resp.getReceipt(client);
  const seq = receipt.topicSequenceNumber;
  if (seq == null) throw new Error('HCS receipt has no topicSequenceNumber');
  return { seq: Number(seq.toString()), txId: resp.transactionId.toString() };
}

/** Decodes raw Mirror rows. Invalid payloads stay in the list as `msg: null` so audits can report them. */
export function decodeAll(raw: MirrorTopicMessage[]): Decoded[] {
  return raw.map((m) => ({
    seq: m.sequence_number,
    payer: m.payer_account_id,
    cts: m.consensus_timestamp,
    msg: decodeHcs(m.message),
  }));
}

export async function readTopic(mirror: Mirror, topicId: string, afterSeq = 0): Promise<Decoded[]> {
  return decodeAll(await mirror.topicMessages(topicId, afterSeq));
}

/** Polls Mirror Node until a given sequence number is visible (Mirror lags consensus by a few seconds). */
export async function waitForSeq(
  mirror: Mirror,
  topicId: string,
  seq: number,
  timeoutMs = MIRROR_WAIT_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Single-message endpoint: no sequencenumber filter (Mirror 400s on gt:0) and no topic walk.
    if (await mirror.topicMessage(topicId, seq)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`HCS seq ${seq} not visible on Mirror Node after ${timeoutMs} ms`);
}

/**
 * Keeps an in-memory, ordered copy of the whole topic. Services call sync() before decisions,
 * and start() for a background poll that reports new messages.
 */
export class TopicFollower {
  readonly messages: Decoded[] = [];
  private lastSeq = 0;
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<Decoded[]> | null = null;

  constructor(
    private readonly mirror: Mirror,
    readonly topicId: string,
  ) {}

  get latestSeq(): number {
    return this.lastSeq;
  }

  /** Fetches anything new. Concurrent callers share one request. Returns only the new messages. */
  sync(): Promise<Decoded[]> {
    if (!this.syncing) {
      this.syncing = (async () => {
        try {
          // Commit one HTTP page at a time: if Mirror fails mid-walk, everything read so far is
          // already committed and the next sync resumes from lastSeq (a cold start never
          // restarts from 0). maxPages=1 is load-bearing — topicMessagesPage's own multi-page
          // walk is all-or-nothing, so a larger bound would discard earlier pages on a throw.
          const fresh: Decoded[] = [];
          for (;;) {
            const page = await this.mirror.topicMessagesPage(this.topicId, this.lastSeq, 1);
            for (const d of decodeAll(page.messages)) {
              if (d.seq === this.lastSeq + 1) {
                this.messages.push(d);
                this.lastSeq = d.seq;
                fresh.push(d);
              }
            }
            // Nothing new committed: stop rather than re-request the same slice forever.
            // The next sync() resumes from lastSeq.
            if (page.complete || page.messages.length === 0) break;
          }
          return fresh;
        } finally {
          this.syncing = null;
        }
      })();
    }
    return this.syncing;
  }

  /** Sync until our own message (seq) is included. */
  async syncThrough(seq: number, timeoutMs = MIRROR_WAIT_TIMEOUT_MS): Promise<void> {
    const start = Date.now();
    while (this.lastSeq < seq) {
      if (Date.now() - start > timeoutMs) throw new Error(`topic follower did not reach seq ${seq}`);
      await this.sync();
      if (this.lastSeq < seq) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  start(intervalMs: number, onNew: (fresh: Decoded[]) => void | Promise<void>): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        const fresh = await this.sync();
        if (fresh.length) await onNew(fresh);
      } catch (err) {
        console.error('[topic-follower]', (err as Error).message);
      }
    };
    void tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
