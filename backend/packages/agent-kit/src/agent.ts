import {
  clientFor,
  directoryFrom,
  inputHashOf,
  jobKeyOf,
  Mirror,
  publishHcs,
  TopicFollower,
  viewJob,
  type JobView,
  type ServiceRow,
} from '@forkos/shared';
import { agentkitClient, agentkitHeaderFor } from './agentkit';
import { ForkosApi } from './api';
import { agentIdentity } from './identity';

export type AgentOptions = {
  key: `0x${string}`;
  token: string;
  apiUrl: string;
  mirrorUrl?: string;
  log?: (msg: string, extra?: unknown) => void;
  onApproval?: (info: { approvalId: string; userCode?: string; verificationUriComplete?: string }) => void;
};

export type BuyOutcome =
  | { kind: 'PAID_BY_ME'; jobKey: string; round: number; result: unknown; intent: unknown }
  | { kind: 'PAID_BY_OTHER'; jobKey: string; round: number; result: unknown; winner: string }
  | { kind: 'FAILED'; jobKey: string; reason: string };

/** True for errors worth retrying: an API 5xx (e.g. Mirror Node unavailable upstream) or a network failure. */
export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const status = /→ (\d{3}) /.exec(msg)?.[1];
  if (status) return Number(status) >= 500;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|network/i.test(msg);
}

export class ForkosAgent {
  readonly id;
  readonly api: ForkosApi;
  private cfg: any;
  private me!: Awaited<ReturnType<ForkosApi['me']>>;
  private follower!: TopicFollower;
  private hedera!: ReturnType<typeof clientFor>;
  private log: NonNullable<AgentOptions['log']>;
  private readonly agentkit;

  constructor(private readonly opts: AgentOptions) {
    this.id = agentIdentity(opts.key);
    this.api = new ForkosApi(opts.apiUrl, opts.token);
    this.agentkit = agentkitClient(opts.key);
    this.log = opts.log ?? ((m, e) => console.log(`[${this.id.address.slice(0, 8)}] ${m}`, e ?? ''));
  }

  async init() {
    this.cfg = await this.api.config();
    this.me = await this.api.me();
    this.hedera = clientFor(this.me.accountId, this.id.hederaKey);
    this.follower = new TopicFollower(new Mirror(this.opts.mirrorUrl ?? this.cfg.mirrorUrl), this.cfg.topicId);
    return this;
  }

  private referee() {
    return { operatorId: this.cfg.operatorId as string, providerAccounts: (this.cfg.providers as { payTo: string }[]).map((p) => p.payTo) };
  }

  async view(jobKey: string): Promise<JobView> {
    await this.follower.sync();
    return viewJob(this.follower.messages, jobKey, this.referee());
  }

  /** Service directory from the HCS topic: SERVICE announcements by the registered provider accounts only. */
  async discover(): Promise<ServiceRow[]> {
    await this.follower.sync();
    const providers = Object.fromEntries((this.cfg.providers as { id: string; payTo: string }[]).map((p) => [p.id, p.payTo]));
    return directoryFrom(this.follower.messages, providers);
  }

  async jobFor(audioUrl: string) {
    const bytes = new Uint8Array(await (await fetch(audioUrl)).arrayBuffer());
    const inputHash = inputHashOf(bytes);
    return { audioUrl, inputHash, jobKey: jobKeyOf(this.me.humanHash, inputHash) };
  }

  /** Posts a CLAIM on HCS (paid by my own account) and reads the referee: first valid claim wins. */
  async claim(jobKey: string, svc: ServiceRow) {
    const before = await this.view(jobKey);
    const round = before.round;
    const { seq } = await publishHcs(this.hedera, this.cfg.topicId, {
      v: 1,
      t: 'CLAIM',
      job: jobKey,
      round,
      human: this.me.humanHash,
      agent: this.id.address,
      epoch: this.me.epoch,
      svc: svc.providerId,
      price: svc.price.toString(),
    });
    this.log(`claimed round ${round} via ${svc.providerId} (HCS seq ${seq})`);
    await this.follower.syncThrough(seq);
    const view = viewJob(this.follower.messages, jobKey, this.referee());
    const won = view.winner?.seq === seq;
    this.log(won ? `WON (seq ${seq})` : `lost to seq ${view.winner?.seq} (${view.claims.find((c) => c.seq === seq)?.reason ?? 'later'})`);
    return { won, round, seq, view };
  }

  private async waitForJob(jobKey: string, until: (j: any) => boolean, timeoutMs = 300_000) {
    const start = Date.now();
    let outage = false;
    for (;;) {
      try {
        const j = await this.api.job(jobKey);
        if (outage) this.log('job status available again');
        outage = false;
        if (until(j)) return j;
      } catch (err) {
        // A Hedera Mirror Node outage reaches us as a 5xx from the API (or a network error). Ride it out until the
        // normal timeout instead of crashing the whole run; a 4xx is a real error and stops immediately.
        if (!isTransient(err)) throw err;
        if (!outage) this.log('job status temporarily unavailable (Mirror Node?) — retrying', (err as Error).message.slice(0, 160));
        outage = true;
      }
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for job');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  /** Full flow: claim → (if winner) pay → result. Losers wait and receive the winner's result. */
  async buy(audioUrl: string, choose: (s: ServiceRow[]) => ServiceRow | Promise<ServiceRow>): Promise<BuyOutcome> {
    const job = await this.jobFor(audioUrl);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.view(job.jobKey);
      if (['PAID', 'DONE', 'REFUNDED'].includes(current.status)) {
        const j = await this.waitForJob(job.jobKey, (x) => ['DONE', 'REFUNDED'].includes(x.status));
        return { kind: 'PAID_BY_OTHER', jobKey: job.jobKey, round: j.round, result: j.intent?.result, winner: current.winner?.agent ?? '' };
      }
      const svc = await choose(await this.discover());
      const c = await this.claim(job.jobKey, svc);
      if (!c.won) {
        const j = await this.waitForJob(job.jobKey, (x) => ['DONE', 'REFUNDED'].includes(x.status) || x.round > c.round);
        if (j.round > c.round) continue; // winner's payment was proven VOID → next round
        return { kind: 'PAID_BY_OTHER', jobKey: job.jobKey, round: j.round, result: j.intent?.result, winner: c.view.winner?.agent ?? '' };
      }
      const out = await this.payLoop(job, c.round, svc);
      if (out) return out;
    }
    return { kind: 'FAILED', jobKey: job.jobKey, reason: 'too many rounds' };
  }

  private async payLoop(job: { jobKey: string; audioUrl: string; inputHash: string }, round: number, svc: ServiceRow): Promise<BuyOutcome | null> {
    for (;;) {
      // World AgentKit: a fresh signed proof per call (challenges are single-use and live 5 min; approvals can take longer)
      const agentkit = await agentkitHeaderFor(this.agentkit, svc, job, round, this.id.address).catch((err) => {
        this.log('agentkit proof skipped', String(err));
        return undefined;
      });
      const r = await this.api.pay({ jobKey: job.jobKey, round, audioUrl: job.audioUrl, inputHash: job.inputHash, agentkit });
      const status = r.body?.status;
      if (r.http === 200) {
        return { kind: 'PAID_BY_ME', jobKey: job.jobKey, round, result: r.body.result, intent: r.body.intent };
      }
      if (r.http === 202 && status === 'APPROVAL_REQUIRED') {
        this.log('over cap → waiting for human approval (World ID)', r.body.verificationUriComplete);
        this.opts.onApproval?.(r.body);
        await new Promise((res) => setTimeout(res, 5000));
        continue; // re-call pay: it consumes the approval once APPROVED
      }
      if (r.http === 202) {
        this.log(`payment ${status} → waiting for the resolver (death clock)`);
        const j = await this.waitForJob(job.jobKey, (x) => ['DONE', 'REFUNDED', 'PAID'].includes(x.status) || x.round > round);
        if (j.round > round) {
          this.log('proven VOID → next round');
          return null;
        }
        const done = await this.waitForJob(job.jobKey, (x) => ['DONE', 'REFUNDED'].includes(x.status));
        return { kind: 'PAID_BY_ME', jobKey: job.jobKey, round, result: done.intent?.result, intent: done.intent };
      }
      if (r.http === 409 && r.body?.error?.code === 'ROUND_CLOSED') return null;
      return { kind: 'FAILED', jobKey: job.jobKey, reason: `${r.http} ${JSON.stringify(r.body)}` };
    }
  }

  close() {
    this.hedera?.close();
  }
}
