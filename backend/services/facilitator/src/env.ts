import { DEFAULT_MIRROR_URL, loadEnv, zHederaId } from '@forkos/shared';
import { z } from 'zod';

export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  FACILITATOR_FEE_PAYER_ID: zHederaId,
  FACILITATOR_FEE_PAYER_KEY: z.string().min(10),
  MIRROR_URL: z.string().url().default(DEFAULT_MIRROR_URL),
});
