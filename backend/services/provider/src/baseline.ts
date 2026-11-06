import { NETWORK } from '@forkos/shared';
import { paymentMiddleware } from '@x402/fastify';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from './config';
import { fetchAudio, transcribeAndSummarize } from './transcribe';
import { resourceServer } from './x402';

const Body = z.object({ audioUrl: z.string().url(), inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/) });

/** Stock x402: no fence, handler runs before settlement. This is what the baseline lane calls. */
export function registerBaseline(app: FastifyInstance) {
  paymentMiddleware(
    app,
    {
      'POST /v1/baseline/jobs': {
        accepts: [
          {
            scheme: 'exact',
            network: NETWORK,
            payTo: env.PROVIDER_ACCOUNT_ID,
            price: { asset: env.PAY_ASSET, amount: env.PROVIDER_PRICE },
            maxTimeoutSeconds: 180,
          },
        ],
        description: 'Baseline (unfenced) transcription',
      },
    },
    resourceServer,
  );

  app.post('/v1/baseline/jobs', async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'bad body' } });
    const audio = await fetchAudio(b.data.audioUrl, b.data.inputHash);
    const out = await transcribeAndSummarize(audio);
    return { provider: env.PROVIDER_ID, summary: out.summary, outputHash: out.outputHash };
  });
}
