import { NETWORK, portFrom } from '@forkos/shared';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import Fastify from 'fastify';
import { sql } from './db';
import { facilitator } from './facilitator';
import { settleOnce } from './settle';

const app = Fastify({ logger: { level: 'info' } });

type Body = { x402Version: number; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };

app.get('/health', async () => ({ ok: true, network: NETWORK, supported: facilitator.getSupported() }));

app.get('/supported', async () => facilitator.getSupported());

app.post<{ Body: Body }>('/verify', async (req) => {
  const { paymentPayload, paymentRequirements } = req.body;
  try {
    return await facilitator.verify(paymentPayload, paymentRequirements);
  } catch (err) {
    req.log.error({ err }, 'verify crashed');
    return { isValid: false, invalidReason: 'forkos_verify_error', invalidMessage: (err as Error).message };
  }
});

app.post<{ Body: Body }>('/settle', async (req) => {
  const { paymentPayload, paymentRequirements } = req.body;
  return settleOnce(paymentPayload, paymentRequirements, req.log);
});

app.get<{ Params: { txId: string } }>('/v1/settlements/:txId', async (req, reply) => {
  const [row] = await sql`select tx_id, status, attempts, last_error, updated_at from fac_settlements where tx_id = ${req.params.txId}`;
  if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'unknown tx' } });
  return row;
});

const port = portFrom('FACILITATOR_PORT', 4020);
await app.listen({ host: '0.0.0.0', port });
