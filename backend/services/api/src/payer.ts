import {
  ApiError,
  H_AGENT,
  H_JOB,
  H_ROUND,
  NETWORK,
  digestOf,
  intentIdOf,
  jobKeyOf,
  memoOf,
  publishHcs,
} from '@forkos/shared';
import { buildIntentPayment, canResend, pickRequirement, type PaymentIntent } from '@forkos/x402-hedera';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPayload } from '@x402/core/types';
import { hedera, services } from './clients';
import { env } from './config';
import { decrypt } from './crypto';
import { sql, type AgentRow, type HumanRow, type IntentRow } from './db';
import { emit } from './events';
import { checkPolicy } from './policy';
import { intentPublic, jobView } from './views';
import { chaos } from './chaosState';

// Header codec only (no schemes needed for encoding / parsing).
const httpClient = new x402HTTPClient(new x402Client());

export type PayInput = { jobKey: string; round: number; audioUrl: string; inputHash: string; approvalId?: string; agentkit?: string };

export async function pay(agent: AgentRow, input: PayInput) {
  // 1. scope: only jobs of this agent's human
  if (jobKeyOf(agent.human_hash, input.inputHash) !== input.jobKey) {
    throw new ApiError('BAD_REQUEST', 'jobKey does not match your human and inputHash');
  }
  // 2. public truth
  const view = await jobView(input.jobKey);
  const existing = await sql<IntentRow[]>`select * from intents where job_key = ${input.jobKey} order by round desc limit 1`;
  if (view.status === 'PAID' || view.status === 'DONE' || view.status === 'REFUNDED') {
    return { http: 200, body: { status: view.status, intent: existing[0] ? intentPublic(existing[0]) : null, result: existing[0]?.result ?? null } };
  }
  if (input.round !== view.round) throw new ApiError('ROUND_CLOSED', `current round is ${view.round}`);
  if (!view.winner || view.winner.agent !== agent.agent_addr) throw new ApiError('NOT_WINNER', 'you are not the HCS winner of this round');
  if (view.winner.epoch !== agent.epoch) throw new ApiError('STALE_AUTHORITY', 'claim epoch is not your current epoch');

  // 3. one intent per (job, round)
  const [same] = await sql<IntentRow[]>`select * from intents where job_key = ${input.jobKey} and round = ${input.round}`;
  if (same) return describe(same);

  // 4. service from the HCS directory (the winner chose it in its claim; registered provider accounts only)
  const service = (await services()).find((s) => s.providerId === view.winner!.svc);
  if (!service) throw new ApiError('UPSTREAM_FAILED', `service ${view.winner.svc} not in the HCS directory`);
  if (service.asset !== env.PAY_ASSET) throw new ApiError('POLICY_DENIED', 'service asks for an unsupported asset');

  // 5. policy
  const decision = await checkPolicy(agent.human_hash, service.providerId, service.price);
  const action = {
    kind: 'OVERCAP',
    human: agent.human_hash,
    jobKey: input.jobKey,
    round: input.round,
    providerId: service.providerId,
    payTo: service.payTo,
    amount: service.price.toString(),
    asset: service.asset,
  };
  if (decision.kind === 'NEEDS_APPROVAL') {
    const approved = await findUsableApproval(agent.human_hash, action);
    if (!approved) return requestOvercap(agent, action, decision.reason);
    input.approvalId = approved;
  }

  // 6. challenge from the provider (fenced there too)
  const headers = {
    'content-type': 'application/json',
    [H_JOB]: input.jobKey,
    [H_ROUND]: String(input.round),
    [H_AGENT]: agent.agent_addr,
  };
  const body = JSON.stringify({ audioUrl: input.audioUrl, inputHash: input.inputHash });
  const challenge = await fetch(service.endpoint, { method: 'POST', headers, body });
  if (challenge.status === 409) {
    const err = (await challenge.json()) as { error: { code: string; message: string } };
    throw new ApiError(err.error.code as never, `provider fence: ${err.error.message}`);
  }
  if (challenge.status !== 402) throw new ApiError('UPSTREAM_FAILED', `expected 402 from provider, got ${challenge.status}`);
  const pr = httpClient.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.json());
  const req = pickRequirement(pr, NETWORK, env.PAY_ASSET);
  // re-quote check: what we are about to sign must match the directory + policy decision
  if (req.payTo !== service.payTo || BigInt(req.amount) !== service.price) {
    throw new ApiError('POLICY_DENIED', 'provider quote differs from the HCS directory (payTo or price changed)');
  }

  // 7. build the intent from the human's budget account; persist BEFORE anything is sent
  const [human] = await sql<HumanRow[]>`select * from humans where human_hash = ${agent.human_hash}`;
  const id = intentIdOf(input.jobKey, input.round);
  let built: { payload: PaymentPayload; intent: PaymentIntent };
  try {
    built = await buildIntentPayment(pr, req, {
      accountId: human!.budget_account_id,
      privateKey: decrypt(human!.budget_key_enc),
      memo: memoOf(input.jobKey, input.round),
      persist: (intent) => persistIntent(id, agent, input, service.providerId, service.endpoint, intent, action),
    });
  } catch (err) {
    // unique (job_key, round) violation = a concurrent request created it first → report that one
    const [raced] = await sql<IntentRow[]>`select * from intents where job_key = ${input.jobKey} and round = ${input.round}`;
    if (raced) return describe(raced);
    throw err;
  }
  // persistIntent stored the payload-less row; store the exact payload now (same bytes on every resend)
  await sql`update intents set payment_payload = ${sql.json(built.payload as never)} where id = ${id}`;

  // 8. public INTENT before sending
  await publishHcs(hedera, env.HCS_TOPIC_ID, {
    v: 1,
    t: 'INTENT',
    job: input.jobKey,
    round: input.round,
    agent: agent.agent_addr,
    tx: built.intent.txId,
    dl: built.intent.deadlineS,
    amt: req.amount,
    asset: req.asset,
    payTo: req.payTo,
  });
  await emit('intent.created', {
    intentId: id,
    jobKey: input.jobKey,
    round: input.round,
    txId: built.intent.txId,
    deadline: built.intent.deadlineS,
    amount: req.amount,
    payTo: req.payTo,
  });

  // 9. send
  const [row] = await sql<IntentRow[]>`select * from intents where id = ${id}`;
  return describe(await sendIntent(row!));
}

async function persistIntent(
  id: string,
  agent: AgentRow,
  input: PayInput,
  providerId: string,
  endpoint: string,
  intent: PaymentIntent,
  action: Record<string, unknown>,
) {
  await sql.begin(async (tx) => {
    if (input.approvalId) {
      const { consumeApproval } = await import('./approvals');
      await consumeApproval(tx as unknown as typeof sql, input.approvalId, action);
    }
    await tx`
      insert into intents (id, job_key, round, human_hash, agent_addr, provider_id, endpoint, pay_to, asset, amount, tx_id,
                           valid_start_ms, deadline_s, memo, payment_payload, requirements, request_body, status, approval_id,
                           agentkit_header)
      values (${id}, ${input.jobKey}, ${input.round}, ${agent.human_hash}, ${agent.agent_addr}, ${providerId}, ${endpoint},
              ${intent.requirements.payTo}, ${intent.requirements.asset}, ${intent.requirements.amount}, ${intent.txId},
              ${intent.validStartMs}, ${intent.deadlineS}, ${intent.memo}, ${tx.json({ pending: true } as never)},
              ${tx.json(intent.requirements as never)},
              ${tx.json({ audioUrl: input.audioUrl, inputHash: input.inputHash } as never)}, 'CREATED', ${input.approvalId ?? null},
              ${input.agentkit ?? null})`;
  });
}

/** Sends (or resends) the stored payload — never re-signs. Returns the updated row. */
export async function sendIntent(row: IntentRow): Promise<IntentRow> {
  if (!canResend(Number(row.deadline_s))) {
    const [r] = await sql<IntentRow[]>`update intents set status = 'PAYMENT_UNKNOWN', updated_at = now() where id = ${row.id} returning *`;
    return r!;
  }
  const view = await jobView(row.job_key);
  const headers = {
    'content-type': 'application/json',
    [H_JOB]: row.job_key,
    [H_ROUND]: String(row.round),
    [H_AGENT]: row.agent_addr,
    ...httpClient.encodePaymentSignatureHeader(row.payment_payload as unknown as PaymentPayload),
    ...(row.agentkit_header ? { agentkit: row.agentkit_header } : {}), // World AgentKit, signed by the agent
    ...(chaos.takeFail() ? { 'x-forkos-chaos-fail': '1' } : {}),
  };
  await sql`update intents set status = 'SENT', attempts = attempts + 1, updated_at = now() where id = ${row.id}`;

  const ctrl = new AbortController();
  const killMs = chaos.takeKill(); // P39: "kill the payer mid-flight"
  const timer = setTimeout(() => ctrl.abort(), killMs ?? 90_000);
  try {
    const res = await fetch(row.endpoint, { method: 'POST', headers, body: JSON.stringify(row.request_body), signal: ctrl.signal });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (res.status === 200) {
      const settle = safeSettle(res);
      const status = json.status === 'REFUNDED' ? 'REFUNDED' : json.status === 'DONE' ? 'DONE' : 'PAID';
      const [r] = await sql<IntentRow[]>`
        update intents set status = ${status}, settle_response = ${sql.json((settle ?? {}) as never)},
               result = ${sql.json(json as never)}, last_error = null, updated_at = now()
         where id = ${row.id} returning *`;
      await afterPaid(r!);
      return r!;
    }
    if (res.status === 202) {
      const [r] = await sql<IntentRow[]>`update intents set status = 'PAYMENT_UNKNOWN', last_error = 'provider still running', updated_at = now() where id = ${row.id} returning *`;
      await emit('payment.unknown', { intentId: row.id, txId: row.tx_id, deadline: Number(row.deadline_s) });
      return r!;
    }
    // 402 / 409 / 4xx: the provider refused → money should not have moved; the resolver proves it (VOID) or finds PAID.
    const reason = json?.error?.code ?? json?.error ?? `http_${res.status}`;
    const [r] = await sql<IntentRow[]>`update intents set status = 'REJECTED', last_error = ${String(reason)}, updated_at = now() where id = ${row.id} returning *`;
    return r!;
  } catch (err) {
    // timeout, abort, connection reset: we do NOT know → resolver
    const [r] = await sql<IntentRow[]>`update intents set status = 'PAYMENT_UNKNOWN', last_error = ${(err as Error).message}, updated_at = now() where id = ${row.id} returning *`;
    await emit('payment.unknown', { intentId: row.id, txId: row.tx_id, deadline: Number(row.deadline_s) });
    return r!;
  } finally {
    clearTimeout(timer);
  }
}

function safeSettle(res: Response) {
  try {
    return httpClient.getPaymentSettleResponse((n) => res.headers.get(n));
  } catch {
    return null;
  }
}

/** PAID/DONE/REFUNDED from a live response: emit now; SETTLED/DONE on HCS are published by the resolver once Mirror confirms. */
async function afterPaid(r: IntentRow) {
  await emit('payment.paid', { intentId: r.id, txId: r.tx_id, consensusTimestamp: null, hashscan: null });
  const result = r.result as { outputHash?: string; summary?: string; refundTxId?: string } | null;
  if (r.status === 'DONE') await emit('job.done', { intentId: r.id, jobKey: r.job_key, outputHash: result?.outputHash, summary: result?.summary });
  if (r.status === 'REFUNDED') await emit('refund.sent', { jobKey: r.job_key, round: r.round, txId: r.tx_id, refundTxId: result?.refundTxId });
}

export function describe(r: IntentRow) {
  const pub = intentPublic(r);
  if (r.status === 'DONE' || r.status === 'PAID' || r.status === 'REFUNDED') return { http: 200, body: { status: r.status, intent: pub, result: r.result } };
  if (r.status === 'VOID' || r.status === 'FAILED') return { http: 409, body: { error: { code: 'ROUND_CLOSED', message: `intent ${r.status}; claim the next round` }, intent: pub } };
  return { http: 202, body: { status: r.status === 'REJECTED' ? 'PAYMENT_UNKNOWN' : r.status, intent: pub } };
}

// ── over-cap approvals (P31) ──

async function findUsableApproval(human: string, action: Record<string, unknown>): Promise<string | null> {
  const [a] = await sql<{ id: string }[]>`
    select id from approvals
     where human_hash = ${human} and kind = 'OVERCAP' and status = 'APPROVED'
       and digest = ${digestOf(action)} and expires_at > now()
     order by created_at desc limit 1`;
  return a?.id ?? null;
}

async function requestOvercap(agent: AgentRow, action: Record<string, unknown>, reason: string) {
  const { createApproval } = await import('./approvals');
  // reuse a still-pending approval for the same action instead of spamming the phone
  const [pending] = await sql<{ id: string; world_attempt_id: string }[]>`
    select id, world_attempt_id from approvals
     where human_hash = ${agent.human_hash} and kind = 'OVERCAP' and status = 'PENDING'
       and digest = ${digestOf(action)} and expires_at > now() limit 1`;
  if (pending) {
    const [w] = await sql<{ user_code: string; verification_uri_complete: string | null }[]>`
      select user_code, verification_uri_complete from world_attempts where id = ${pending.world_attempt_id}`;
    return { http: 202, body: { status: 'APPROVAL_REQUIRED', approvalId: pending.id, userCode: w?.user_code, verificationUriComplete: w?.verification_uri_complete, reason } };
  }
  const [human] = await sql<HumanRow[]>`select * from humans where human_hash = ${agent.human_hash}`;
  const created = await createApproval(agent.human_hash, human!.sub, 'OVERCAP', action);
  return {
    http: 202,
    body: { status: 'APPROVAL_REQUIRED', approvalId: created.approvalId, userCode: created.userCode, verificationUriComplete: created.verificationUriComplete, reason },
  };
}
