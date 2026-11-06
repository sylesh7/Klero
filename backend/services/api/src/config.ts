import { DEFAULT_MIRROR_URL, loadDeployments, loadEnv, zHederaId, zIntString } from '@forkos/shared';
import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 hex chars (32 bytes)');

export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  MIRROR_URL: z.string().url().default(DEFAULT_MIRROR_URL),
  OPERATOR_ID: zHederaId,
  OPERATOR_KEY: z.string().min(10),
  PAY_ASSET: zHederaId,
  PAY_ASSET_DECIMALS: z.coerce.number().int().min(0).max(18),
  HCS_TOPIC_ID: zHederaId,
  FACILITATOR_URL: z.string().url(),
  AGENT_HBAR_FUND: z.coerce.number().positive().default(5),
  HUMAN_FUSD_FUND: zIntString.default('20000000'),
  HUMAN_HBAR_FUND: z.coerce.number().positive().default(2),
  API_PUBLIC_URL: z.string().url(),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: hex32,
  KEY_ENCRYPTION_SECRET: hex32,
  HUMAN_SALT: hex32,
  WORLD_ISSUER: z.string().url(),
  WORLD_CLIENT_ID: z.string().min(1),
  WORLD_CLIENT_SECRET: z.string().min(1),
  WORLD_SUB_STABLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WORLD_FRESH_SECONDS: z.coerce.number().int().positive().default(300),
  // Optional space-separated acr_values sent on every device authorization. Setting it to
  // https://world.org/oidc/acr/orb-face makes World ask for a World ID app proof (Orb + Face Auth)
  // instead of offering a passkey first. Empty = World's default behaviour.
  WORLD_ACR_VALUES: z.string().trim().default(''),
  POLICY_DEFAULT_CAP: zIntString.default('1000000'),
  POLICY_DEFAULT_DAILY: zIntString.default('5000000'),
  DEMO_KEY: z.string().min(16),
  SAMPLE_AUDIO_URL: z.string().url(),
});

export const dep = loadDeployments();
if (dep.operatorId !== env.OPERATOR_ID) throw new Error('OPERATOR_ID differs from deployments/testnet.json');
if (dep.topicId !== env.HCS_TOPIC_ID) throw new Error('HCS_TOPIC_ID differs from deployments/testnet.json');

export const PROVIDER_ACCOUNTS = Object.values(dep.providers).map((p) => p.accountId);
export const PROVIDER_IDS = Object.keys(dep.providers);
export const REFEREE = { operatorId: env.OPERATOR_ID, providerAccounts: PROVIDER_ACCOUNTS };
export const WEB_ORIGINS = env.WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
