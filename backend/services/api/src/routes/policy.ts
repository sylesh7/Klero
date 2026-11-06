import { zIntString } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOwner } from '../auth';
import { PROVIDER_IDS } from '../config';
import { policyView, updatePolicy } from '../policy';

const Patch = z.object({
  capPerPayment: zIntString.optional(),
  dailyCap: zIntString.optional(),
  allowlist: z.array(z.enum(PROVIDER_IDS as [string, ...string[]])).optional(),
});

export function registerPolicyRoutes(app: FastifyInstance) {
  app.get('/v1/policy', async (req) => policyView((await requireOwner(req)).human_hash));
  app.put('/v1/policy', async (req) => updatePolicy((await requireOwner(req)).human_hash, Patch.parse(req.body)));
}
