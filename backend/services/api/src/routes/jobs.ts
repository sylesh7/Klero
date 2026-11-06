import { ApiError, CAPABILITY, NETWORK, HASHSCAN_BASE } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { requireOwnerOrAgent } from '../auth';
import { dep, env } from '../config';
import { sql, type IntentRow } from '../db';
import { directory, intentPublic, jobView, latestIntent, timeline } from '../views';

export function registerJobRoutes(app: FastifyInstance) {
  app.get('/v1/config', async () => ({
    network: NETWORK,
    capability: CAPABILITY,
    topicId: env.HCS_TOPIC_ID,
    operatorId: env.OPERATOR_ID,
    asset: env.PAY_ASSET,
    assetDecimals: env.PAY_ASSET_DECIMALS,
    mirrorUrl: env.MIRROR_URL,
    hashscan: HASHSCAN_BASE,
    providers: Object.entries(dep.providers).map(([id, p]) => ({ id, name: p.name, price: p.price, payTo: p.accountId })),
    baselineAgents: dep.baselineAgents,
    world: { issuer: env.WORLD_ISSUER, subStable: env.WORLD_SUB_STABLE },
  }));

  app.get<{ Params: { jobKey: string } }>('/v1/jobs/:jobKey', async (req) => {
    await requireOwnerOrAgent(req);
    const view = await jobView(req.params.jobKey);
    const intent = await latestIntent(req.params.jobKey);
    return { ...view, intent: intent ? intentPublic(intent) : null, onchainIntent: view.intent };
  });

  app.get<{ Params: { intentId: string } }>('/v1/intents/:intentId', async (req) => {
    await requireOwnerOrAgent(req);
    const [i] = await sql<IntentRow[]>`select * from intents where id = ${req.params.intentId}`;
    if (!i) throw new ApiError('NOT_FOUND', 'unknown intent');
    return intentPublic(i);
  });

  app.get('/v1/directory', async () => ({ services: await directory() }));
  app.get<{ Querystring: { jobKey: string } }>('/v1/timeline', async (req) => ({ events: await timeline(req.query.jobKey) }));
}
