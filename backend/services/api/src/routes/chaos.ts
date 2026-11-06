import { ApiError, H_AGENT, H_JOB, H_ROUND } from '@forkos/shared';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDemo } from '../auth';
import { chaos } from '../chaosState';
import { services } from '../clients';
import { env } from '../config';
import { sql, type IntentRow } from '../db';
import { emit } from '../events';
import { jobView } from '../views';

const facilitator = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });

export function registerChaosRoutes(app: FastifyInstance) {
  app.post('/v1/chaos/kill-next-payer', async (req) => {
    requireDemo(req);
    chaos.armKill();
    await emit('chaos', { kind: 'kill-next-payer', detail: 'next payment HTTP call is aborted 400 ms after sending' });
    return { armed: true };
  });

  app.post('/v1/chaos/fail-next-job', async (req) => {
    requireDemo(req);
    chaos.armFail();
    await emit('chaos', { kind: 'fail-next-job', detail: 'next job fails after payment → HTS refund' });
    return { armed: true };
  });

  app.post<{ Params: { intentId: string } }>('/v1/chaos/replay/:intentId', async (req) => {
    requireDemo(req);
    const [i] = await sql<IntentRow[]>`select * from intents where id = ${req.params.intentId}`;
    if (!i) throw new ApiError('NOT_FOUND', 'unknown intent');
    const settle = await facilitator.settle(i.payment_payload as unknown as PaymentPayload, i.requirements as unknown as PaymentRequirements);
    await emit('chaos', { kind: 'replay', detail: { intentId: i.id, txId: i.tx_id, success: settle.success, reason: settle.errorReason } });
    return { facilitator: settle };
  });

  app.post<{ Params: { agentAddr: string } }>('/v1/chaos/revive/:agentAddr', async (req) => {
    requireDemo(req);
    const { jobKey } = z.object({ jobKey: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.body);
    const agentAddr = req.params.agentAddr.toLowerCase();
    const view = await jobView(jobKey);
    const claim = [...view.claims].reverse().find((c) => c.agent === agentAddr);
    if (!claim) throw new ApiError('NOT_FOUND', 'this agent has no claim on that job');
    const svc = (await services()).find((s) => s.providerId === claim.svc);
    if (!svc) throw new ApiError('NOT_FOUND', 'service not in directory');
    const res = await fetch(svc.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [H_JOB]: jobKey, [H_ROUND]: String(view.round), [H_AGENT]: agentAddr },
      body: JSON.stringify({ audioUrl: env.SAMPLE_AUDIO_URL, inputHash: 'sha256:' + '0'.repeat(64) }),
    });
    const body = await res.json().catch(() => ({}));
    await emit('chaos', { kind: 'revive', detail: { agentAddr, status: res.status, body } });
    return { provider: { status: res.status, body } };
  });
}
