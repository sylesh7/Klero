import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { portFrom } from '@forkos/shared';
import Fastify from 'fastify';
import { registerBaseline } from './baseline';
import { env } from './config';
import { serviceSeq, startDirectoryRefresh } from './directory';
import { follower } from './hcs';
import { startReconciler } from './reconciler';
import { registerJobRoutes } from './routes';
import { initX402 } from './x402';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 1_000_000 });

await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  prefix: '/',
});

app.get('/health', async () => ({
  ok: true,
  providerId: env.PROVIDER_ID,
  price: env.PROVIDER_PRICE,
  payTo: env.PROVIDER_ACCOUNT_ID,
  serviceSeq, // HCS sequence number of our SERVICE announcement
  hcsSeq: follower.latestSeq,
}));

await initX402();
registerJobRoutes(app);
registerBaseline(app);
follower.start(3000, () => {});
startReconciler(app.log);
startDirectoryRefresh(app.log);

const port = portFrom('PROVIDER_PORT', 4031);
await app.listen({ host: '0.0.0.0', port });
