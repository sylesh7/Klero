import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { setApprovalStatus } from '../approvals';
import { requireAgent } from '../auth';
import type { AttemptRow } from '../db';
import { pay } from '../payer';
import { onWorldApproved, onWorldNotApproved } from '../world';

const Body = z.object({
  jobKey: z.string().regex(/^[0-9a-f]{64}$/),
  round: z.number().int().nonnegative(),
  audioUrl: z.string().url(),
  inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export function registerPayRoutes(app: FastifyInstance) {
  onWorldApproved('OVERCAP', async (row: AttemptRow) => {
    await setApprovalStatus((row.context as { approvalId: string }).approvalId, 'APPROVED');
  });
  onWorldNotApproved('OVERCAP', async (row: AttemptRow) => {
    await setApprovalStatus((row.context as { approvalId: string }).approvalId, row.status === 'EXPIRED' ? 'EXPIRED' : 'DENIED');
  });

  app.post('/v1/pay', async (req, reply) => {
    const agent = await requireAgent(req);
    const out = await pay(agent, Body.parse(req.body));
    return reply.code(out.http).send(out.body);
  });
}
