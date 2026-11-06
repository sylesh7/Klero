import { DEFAULT_MIRROR_URL } from './constants';
import { toMirrorTxId } from './hedera';

export type MirrorTransfer = { account: string; amount: number; is_approval?: boolean };
export type MirrorTokenTransfer = { token_id: string; account: string; amount: number; is_approval?: boolean };

export type MirrorTransaction = {
  transaction_id: string;
  consensus_timestamp: string;
  result: string;
  name: string;
  memo_base64: string;
  scheduled: boolean;
  nonce: number;
  valid_start_timestamp: string;
  valid_duration_seconds?: string;
  charged_tx_fee: number;
  transfers: MirrorTransfer[];
  token_transfers?: MirrorTokenTransfer[];
};

export type TxLookup =
  | { found: false }
  | { found: true; success: boolean; result: string; consensusTimestamp: string; memo: string; tx: MirrorTransaction };

export type MirrorTopicMessage = {
  consensus_timestamp: string;
  message: string; // base64
  payer_account_id: string;
  running_hash: string;
  running_hash_version: number;
  sequence_number: number;
  topic_id: string;
  chunk_info?: { number: number; total: number } | null;
};

export type MirrorOptions = {
  /** Per-attempt deadline. Without one, a silently stalled connection hangs for undici's 300 s default. */
  timeoutMs?: number;
  /** Total attempts for network errors, timeouts and 5xx. 404 and other 4xx are answers, never retried. */
  attempts?: number;
  retryDelayMs?: number;
};

export class Mirror {
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor(readonly baseUrl: string = DEFAULT_MIRROR_URL, opts: MirrorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.attempts = Math.max(1, opts.attempts ?? 3);
    this.retryDelayMs = opts.retryDelayMs ?? 1_000;
  }

  private async get<T>(path: string): Promise<{ status: 200; body: T } | { status: 404 }> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastErr = e; // network error or timeout: transient, try again
        if (attempt < this.attempts) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
        continue;
      }
      if (res.status === 404) return { status: 404 };
      if (res.ok) return { status: 200, body: (await res.json()) as T };
      const err = new Error(`Mirror ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
      if (res.status < 500) throw err; // a 4xx is an answer, not an outage
      lastErr = err;
      if (attempt < this.attempts) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Mirror request failed for ${path}`);
  }

  /** Look up an SDK tx id. PAID if any non-scheduled, nonce-0 entry has result SUCCESS. */
  async getTransaction(sdkTxId: string): Promise<TxLookup> {
    const r = await this.get<{ transactions: MirrorTransaction[] }>(`/api/v1/transactions/${toMirrorTxId(sdkTxId)}`);
    if (r.status === 404 || r.body.transactions.length === 0) return { found: false };
    const parents = r.body.transactions.filter((t) => !t.scheduled && (t.nonce ?? 0) === 0);
    const list = parents.length ? parents : r.body.transactions;
    const ok = list.find((t) => t.result === 'SUCCESS');
    const t = ok ?? list[0]!;
    return {
      found: true,
      success: Boolean(ok),
      result: t.result,
      consensusTimestamp: t.consensus_timestamp,
      memo: t.memo_base64 ? Buffer.from(t.memo_base64, 'base64').toString('utf8') : '',
      tx: t,
    };
  }

  /**
   * One bounded slice: messages with sequence_number > afterSeq, ascending, at most maxPages x 100.
   * Always a GAP-FREE PREFIX (afterSeq+1, +2, ...): never wrong, only possibly incomplete.
   * complete:false -> call again with the last seq returned.
   * Mirror rejects `sequencenumber=gt:0` with 400 (HCS seqs start at 1), so the filter is
   * omitted below seq 1. Verified against live testnet.
   */
  async topicMessagesPage(
    topicId: string,
    afterSeq = 0,
    maxPages = 50,
  ): Promise<{ messages: MirrorTopicMessage[]; complete: boolean }> {
    const filter = afterSeq >= 1 ? `&sequencenumber=gt:${afterSeq}` : '';
    let path: string | null = `/api/v1/topics/${topicId}/messages?order=asc&limit=100${filter}`;
    const out: MirrorTopicMessage[] = [];
    let expect = Math.max(1, afterSeq + 1); // HCS seqs start at 1, so afterSeq <= 0 expects seq 1
    let pages = 0;
    while (path && pages < maxPages) {
      const r: { status: 200; body: { messages: MirrorTopicMessage[]; links: { next: string | null } } } | { status: 404 } =
        await this.get<{ messages: MirrorTopicMessage[]; links: { next: string | null } }>(path);
      pages++;
      if (r.status === 404) return { messages: out, complete: true };
      for (const m of r.body.messages) {
        if (m.sequence_number < expect) continue; // overlap between pages (next is a timestamp cursor)
        if (m.sequence_number !== expect) {
          throw new Error(`Mirror gap on ${topicId}: expected seq ${expect}, got ${m.sequence_number}`);
        }
        out.push(m);
        expect++;
      }
      path = r.body.links?.next ?? null;
    }
    return { messages: out, complete: path === null };
  }

  /**
   * Whole tail after afterSeq (audit CLI, tests). Resumes slice by slice, so progress is never
   * thrown away: a mid-walk Mirror failure keeps what the caller already has.
   */
  async topicMessages(topicId: string, afterSeq = 0): Promise<MirrorTopicMessage[]> {
    const all: MirrorTopicMessage[] = [];
    let after = afterSeq;
    for (;;) {
      const p = await this.topicMessagesPage(topicId, after);
      all.push(...p.messages);
      if (p.complete) return all;
      // A slice that is neither complete nor advancing would make this loop spin on an
      // identical request forever (reachable when maxPages is hit on all-overlap pages).
      if (p.messages.length === 0) {
        throw new Error(
          `Mirror topicMessages(${topicId}) stalled: incomplete slice after seq ${after} returned no new messages`,
        );
      }
      after = p.messages[p.messages.length - 1]!.sequence_number;
    }
  }

  /** Exactly one message by sequence number, or null if Mirror does not have it yet. */
  async topicMessage(topicId: string, seq: number): Promise<MirrorTopicMessage | null> {
    const r = await this.get<MirrorTopicMessage>(`/api/v1/topics/${topicId}/messages/${seq}`);
    return r.status === 404 ? null : r.body;
  }

  /** Recent CRYPTOTRANSFER transactions that touched an account (newest first). */
  async accountTransfers(accountId: string, limit = 100): Promise<MirrorTransaction[]> {
    const r = await this.get<{ transactions: MirrorTransaction[] }>(
      `/api/v1/transactions?account.id=${accountId}&transactiontype=CRYPTOTRANSFER&order=desc&limit=${limit}`,
    );
    return r.status === 404 ? [] : r.body.transactions;
  }

  async hbarBalance(accountId: string): Promise<bigint> {
    const r = await this.get<{ balance: { balance: number } }>(`/api/v1/accounts/${accountId}`);
    return r.status === 404 ? 0n : BigInt(r.body.balance.balance);
  }

  async tokenBalance(accountId: string, tokenId: string): Promise<bigint> {
    const r = await this.get<{ tokens: { token_id: string; balance: number }[] }>(
      `/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`,
    );
    if (r.status === 404) return 0n;
    const row = r.body.tokens.find((t) => t.token_id === tokenId);
    return row ? BigInt(row.balance) : 0n;
  }
}
