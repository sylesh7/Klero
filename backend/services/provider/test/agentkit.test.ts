// World AgentKit fence check (services/provider/src/agentkit.ts) against the real AgentKit verification code.
// Only the AgentBook lookup (a World Chain RPC call) is stubbed.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const REGISTERED = new Set<string>();
vi.mock('@worldcoin/agentkit', async (orig) => {
  const real = await orig<typeof import('@worldcoin/agentkit')>();
  return { ...real, createAgentBookVerifier: () => ({ lookupHuman: async (a: string) => (REGISTERED.has(a.toLowerCase()) ? 'human-42' : null) }) };
});

// config.ts validates env at import time
Object.assign(process.env, {
  DATABASE_URL: 'postgres://x', FACILITATOR_URL: 'http://localhost:4020', PAY_ASSET: '0.0.7', PAY_ASSET_DECIMALS: '6',
  HCS_TOPIC_ID: '0.0.9', PROVIDER_ID: 'scribe-a', PROVIDER_NAME: 'Scribe A', PROVIDER_PRICE: '50000',
  PROVIDER_ACCOUNT_ID: '0.0.11332881', PROVIDER_ACCOUNT_KEY: '0x' + '1'.repeat(64), PROVIDER_PUBLIC_URL: 'http://localhost:4031',
  OPENAI_API_KEY: 'sk-test', PROVIDER_AGENTKIT: 'verify',
});

type Mod = typeof import('../src/agentkit');
let ak: Mod;
let env: { PROVIDER_AGENTKIT: string };
const { createAgentkitClient } = await import('@worldcoin/agentkit');

beforeAll(async () => {
  ak = await import('../src/agentkit');
  env = (await import('../src/config')).env as never;
});

const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const AGENT = agent.address.toLowerCase();

async function signedHeader(key = agentKey) {
  const acct = privateKeyToAccount(key);
  const client = createAgentkitClient({ signer: { address: acct.address, chainId: 'eip155:480', type: 'eip191', signMessage: (m) => acct.signMessage({ message: m }) } });
  const ext = (await ak.agentkitChallenge())!.agentkit;
  return client.createHeader(ext as never);
}

describe('provider AgentKit fence', () => {
  it('accepts a fresh proof signed by the winning agent and resolves its AgentBook human', async () => {
    env.PROVIDER_AGENTKIT = 'verify';
    REGISTERED.add(AGENT);
    const r = await ak.checkAgentkit(await signedHeader(), AGENT);
    expect(r).toEqual({ ok: true, humanId: 'human-42', address: AGENT });
    REGISTERED.clear();
  });

  it('refuses a replayed proof (each challenge nonce is single-use)', async () => {
    env.PROVIDER_AGENTKIT = 'verify';
    const h = await signedHeader();
    expect((await ak.checkAgentkit(h, AGENT)).ok).toBe(true);
    const again = await ak.checkAgentkit(h, AGENT);
    expect(again).toMatchObject({ ok: false, code: 'NOT_HUMAN_BACKED' });
  });

  it('refuses a proof signed by a different wallet than the winning agent', async () => {
    env.PROVIDER_AGENTKIT = 'verify';
    const r = await ak.checkAgentkit(await signedHeader(generatePrivateKey()), AGENT);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('different wallet') });
  });

  it('refuses a proof for a challenge this provider never issued', async () => {
    env.PROVIDER_AGENTKIT = 'verify';
    const { agentkitResourceServerExtension, declareAgentkitExtension } = await import('@worldcoin/agentkit');
    const decl = declareAgentkitExtension({ network: 'eip155:480', resourceUri: 'http://localhost:4031/v1/jobs' }).agentkit;
    const foreign = await agentkitResourceServerExtension.enrichPaymentRequiredResponse!(decl, { resourceInfo: { url: 'http://localhost:4031/v1/jobs' }, requirements: [] } as never);
    const client = createAgentkitClient({ signer: { address: agent.address, chainId: 'eip155:480', type: 'eip191', signMessage: (m) => agent.signMessage({ message: m }) } });
    const r = await ak.checkAgentkit(await client.createHeader(foreign as never), AGENT);
    expect(r.ok).toBe(false);
  });

  it('refuses garbage', async () => {
    env.PROVIDER_AGENTKIT = 'verify';
    expect(await ak.checkAgentkit('not-base64-json', AGENT)).toMatchObject({ ok: false, code: 'NOT_HUMAN_BACKED' });
  });

  it('verify mode: a valid proof from an unregistered wallet is allowed (humanId null); no header is allowed', async () => {
    env.PROVIDER_AGENTKIT = 'verify';
    expect(await ak.checkAgentkit(await signedHeader(), AGENT)).toEqual({ ok: true, humanId: null, address: AGENT });
    expect(await ak.checkAgentkit(undefined, AGENT)).toEqual({ ok: true, humanId: null, address: null });
  });

  it('require mode: unregistered wallets and missing proofs are refused; registered ones pass', async () => {
    env.PROVIDER_AGENTKIT = 'require';
    expect(await ak.checkAgentkit(await signedHeader(), AGENT)).toMatchObject({ ok: false, message: expect.stringContaining('not registered') });
    expect(await ak.checkAgentkit(undefined, AGENT)).toMatchObject({ ok: false, code: 'NOT_HUMAN_BACKED' });
    REGISTERED.add(AGENT);
    expect(await ak.checkAgentkit(await signedHeader(), AGENT)).toMatchObject({ ok: true, humanId: 'human-42' });
    REGISTERED.clear();
  });

  it('off mode: no challenge, nothing checked', async () => {
    env.PROVIDER_AGENTKIT = 'off';
    expect(await ak.agentkitChallenge()).toBeUndefined();
    expect(await ak.checkAgentkit('anything', AGENT)).toEqual({ ok: true, humanId: null, address: null });
  });
});
