import {
  DEFAULT_MIRROR_URL,
  loadDeployments,
  providerAccountsOf,
  loadEnv,
  zHederaId,
  zIntString,
} from '@forkos/shared';
import { z } from 'zod';

export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  MIRROR_URL: z.string().url().default(DEFAULT_MIRROR_URL),
  FACILITATOR_URL: z.string().url(),
  PAY_ASSET: zHederaId,
  PAY_ASSET_DECIMALS: z.coerce.number().int().min(0).max(18),
  HCS_TOPIC_ID: zHederaId,
  PROVIDER_ID: z.enum(['scribe-a', 'scribe-b', 'scribe-premium']),
  PROVIDER_NAME: z.string().min(1).max(64),
  PROVIDER_PRICE: zIntString,
  PROVIDER_ACCOUNT_ID: zHederaId,
  PROVIDER_ACCOUNT_KEY: z.string().min(10),
  PROVIDER_PUBLIC_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_STT_MODEL: z.string().default('whisper-1'),
  PROVIDER_ALLOW_CHAOS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // World AgentKit (human-backed agents). off: ignored. verify: a header, if sent, must be valid (forged or
  // replayed headers are refused); records the AgentBook human. require: only agents whose wallet is registered
  // in World AgentBook are served.
  PROVIDER_AGENTKIT: z.enum(['off', 'verify', 'require']).default('off'),
});

const dep = loadDeployments();
export const OPERATOR_ID = dep.operatorId;
export const PROVIDER_ACCOUNTS = Object.values(dep.providers).map((p) => p.accountId);
export const PROVIDER_ACCOUNT_MAP = providerAccountsOf(dep.providers);
export const ENDPOINT = `${env.PROVIDER_PUBLIC_URL.replace(/\/$/, '')}/v1/jobs`;
if (Buffer.byteLength(ENDPOINT) > 256) throw new Error('PROVIDER_PUBLIC_URL too long for the HCS SERVICE message (256 bytes)');
