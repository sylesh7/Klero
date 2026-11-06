import { H_AGENT, H_JOB, H_ROUND } from '@forkos/shared';
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { agentkitChallenge, checkAgentkit } from './agentkit';
import { env } from './config';
import { sql, type JobRow } from './db';
import { fence } from './fence';
import { runJob } from './jobs';
import { refundJob } from './refunds';
import { requirements, resourceServer, send402, txIdOfPayload } from './x402';

export const JobBody = z.object({
  audioUrl: z.string().url(),
  inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const JobHeaders = z.object({
  [H_JOB]: z.string().regex(/^[0-9a-f]{64}$/),
  [H_ROUND]: z.coerce.number().int().nonnegative(),
  [H_AGENT]: z.string().regex(/^0x[0-9a-f]{40}$/),
});

function fenceError(reply: FastifyReply, code: string, message: string) {
  return reply.code(409).send({ error: { code, message } });
}

/** Shape returned for a job row (200 when DONE). */
export function jobResponse(row: JobRow) {
  return {
    jobId: row.id,
    status: row.status,
    txId: row.payment_tx_id,
    transcript: row.transcript,
    summary: row.summary,
    outputHash: row.output_hash,
    refundTxId: row.refund_tx_id,
    error: row.error,
    // World AgentKit: the anonymous AgentBook human behind the paying agent (null when not proven)
    agentkit: row.agentkit_address ? { address: row.agentkit_address, humanId: row.agentkit_human } : null,
  };
}

export function registerJobRoutes(app: FastifyInstance) {
  app.post('/v1/jobs', async (req, reply) => {
    // 0. parse
    const h = JobHeaders.safeParse(req.headers);
    const b = JobBody.safeParse(req.body);
    if (!h.success || !b.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'missing ForkOS headers or body' } });
    }
    const jobKey = h.data[H_JOB];
    const round = h.data[H_ROUND];
    const agent = h.data[H_AGENT];
    const reqs = await requirements();
    const sig = (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined;

    // 1. challenge (after a fence, so losers/stale agents get 409 not a price)
    if (!sig) {
      const f = await fence({ jobKey, round, agent });
      if (!f.ok) return fenceError(reply, f.code, f.message);
      return send402(reply, reqs, undefined, await agentkitChallenge());
    }

    // 2. decode
    let payload;
    let txId: string;
    try {
      payload = decodePaymentSignatureHeader(sig);
      txId = txIdOfPayload(payload);
    } catch {
      return send402(reply, reqs, 'invalid_payment_payload');
    }
    const matched = resourceServer.findMatchingRequirements(reqs, payload);
    if (!matched) return send402(reply, reqs, 'payment_requirements_mismatch');

    // 3. idempotent: this exact payment already processed?
    const [existing] = await sql<JobRow[]>`select * from prov_jobs where payment_tx_id = ${txId}`;
    if (existing) {
      if (existing.status === 'DONE') return reply.code(200).send(jobResponse(existing));
      if (existing.status === 'PAYING' || existing.status === 'RUNNING') return reply.code(202).send(jobResponse(existing));
      return reply.code(409).send({ error: { code: 'ALREADY_EXECUTED', message: `payment already ${existing.status}` }, job: jobResponse(existing) });
    }

    // 4. fence (nothing settled yet)
    const f1 = await fence({ jobKey, round, agent });
    if (!f1.ok) return fenceError(reply, f1.code, f1.message);
    // 4b. World AgentKit: is the winning agent's wallet backed by a real human? (nothing settled yet)
    const ak = await checkAgentkit(req.headers['agentkit'] as string | undefined, agent);
    if (!ak.ok) return fenceError(reply, ak.code, ak.message);

    // 5. verify
    const verify = await resourceServer.verifyPayment(payload, matched);
    if (!verify.isValid) return send402(reply, reqs, verify.invalidReason ?? 'verification_failed');

    // 6. record before settling
    const id = `${env.PROVIDER_ID}:${txId}`;
    await sql`
      insert into prov_jobs (id, provider_id, job_key, round, agent_addr, payment_tx_id, payer_account, amount, status, audio_url, input_hash,
                             agentkit_human, agentkit_address)
      values (${id}, ${env.PROVIDER_ID}, ${jobKey}, ${round}, ${agent}, ${txId}, ${verify.payer ?? null},
              ${matched.amount}, 'PAYING', ${b.data.audioUrl}, ${b.data.inputHash}, ${ak.humanId}, ${ak.address})
      on conflict (payment_tx_id) do nothing`;

    // 7. settle
    const settle = await resourceServer.settlePayment(payload, matched);
    if (!settle.success) {
      await sql`update prov_jobs set status = 'PAYMENT_FAILED', error = ${settle.errorReason ?? 'settle failed'}, updated_at = now() where id = ${id}`;
      return send402(reply, reqs, settle.errorReason ?? 'settlement_failed');
    }
    reply.header('PAYMENT-RESPONSE', encodePaymentResponseHeader(settle));

    // 8 + 9. fence again at the execution point, then run (or refund)
    const chaosFail = env.PROVIDER_ALLOW_CHAOS && req.headers['x-forkos-chaos-fail'] === '1';
    const row = await runJob(id, { jobKey, round, agent, chaosFail }, req.log);
    if (row.status === 'FAILED') {
      const refunded = await refundJob(row, req.log);
      return reply.code(200).send(jobResponse(refunded));
    }
    // 10.
    return reply.code(200).send(jobResponse(row));
  });

  app.get<{ Params: { txId: string } }>('/v1/jobs/by-payment/:txId', async (req, reply) => {
    const [row] = await sql<JobRow[]>`select * from prov_jobs where payment_tx_id = ${req.params.txId}`;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'unknown payment' } });
    return jobResponse(row);
  });
}
