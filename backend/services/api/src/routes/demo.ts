import { inputHashOf } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { requireDemo } from '../auth';
import { env } from '../config';

let cached: { audioUrl: string; inputHash: string } | null = null;

export function registerDemoRoutes(app: FastifyInstance) {
  app.post('/v1/demo/job', async (req) => {
    requireDemo(req);
    if (!cached) {
      const bytes = new Uint8Array(await (await fetch(env.SAMPLE_AUDIO_URL)).arrayBuffer());
      cached = { audioUrl: env.SAMPLE_AUDIO_URL, inputHash: inputHashOf(bytes) };
    }
    return cached;
  });
}
