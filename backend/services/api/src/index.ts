import cors from '@fastify/cors';
import { ApiError, NETWORK, portFrom } from '@forkos/shared';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { follower } from './clients';
import { env, WEB_ORIGINS } from './config';
import { registerSse } from './events';
import { onNewMessages } from './feed';
import { startResolver } from './resolver';
import { registerAgentRoutes } from './routes/agents';
import { registerChaosRoutes } from './routes/chaos';
import { registerCounterRoutes } from './routes/counter';
import { registerDemoRoutes } from './routes/demo';
import { registerJobRoutes } from './routes/jobs';
import { registerOwnerRoutes } from './routes/owner';
import { registerPayRoutes } from './routes/pay';
import { registerPolicyRoutes } from './routes/policy';
import { startWorldWorker } from './world';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 1_000_000 });

await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || WEB_ORIGINS.includes('*') || WEB_ORIGINS.includes(origin)),
  allowedHeaders: ['content-type', 'authorization', 'x-demo-key', 'last-event-id'],
  methods: ['GET', 'POST', 'PUT'],
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ApiError) return reply.code(err.status).send(err.toJSON());
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
  }
  req.log.error({ err }, 'unhandled');
  return reply.code(500).send({ error: { code: 'UPSTREAM_FAILED', message: (err as Error).message } });
});

app.get('/v1/health', async () => ({ ok: true, network: NETWORK, topicId: env.HCS_TOPIC_ID, asset: env.PAY_ASSET, hcsSeq: follower.latestSeq, version: '0.1.0' }));

registerSse(app);
registerOwnerRoutes(app);
registerAgentRoutes(app);
registerPolicyRoutes(app);
registerJobRoutes(app);
registerPayRoutes(app);
registerCounterRoutes(app);
registerDemoRoutes(app);
registerChaosRoutes(app);

follower.start(2000, onNewMessages);
startWorldWorker(app.log);
startResolver(app.log);

const port = portFrom('API_PORT', 4040);
await app.listen({ host: '0.0.0.0', port });
