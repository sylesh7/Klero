// World AgentKit: prove the paying agent's wallet is backed by a real human (World AgentBook on World Chain).
// The challenge rides in the x402 402 response as the standard `extensions.agentkit`; the agent signs it (SIWE)
// with its own key and the payer relays the `agentkit` header. Payment itself stays on Hedera — AgentKit is not
// registered as an x402 hook, so it can never change how a payment is verified or settled.
import {
  agentkitResourceServerExtension,
  createAgentBookVerifier,
  declareAgentkitExtension,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
} from '@worldcoin/agentkit';
import { ENDPOINT, env } from './config';

/** The chain the agent signs for (AgentBook lives on World Chain). Not the payment network. */
export const AGENTKIT_CHAIN = 'eip155:480';
const CHALLENGE_TTL_S = 300;

const agentBook = createAgentBookVerifier();
const issued = new Map<string, number>(); // nonce -> expiry (ms). Only nonces we issued are accepted, once.

function sweep() {
  const now = Date.now();
  for (const [nonce, exp] of issued) if (exp < now) issued.delete(nonce);
}

/** Consume a nonce: valid only if this provider issued it, it is unexpired, and it was never used. */
function consumeNonce(nonce: string): boolean {
  const exp = issued.get(nonce);
  if (!exp || exp < Date.now()) return false;
  issued.delete(nonce);
  return true;
}

/** `extensions` for a 402 response, or undefined when AgentKit is off. */
export async function agentkitChallenge(): Promise<Record<string, unknown> | undefined> {
  if (env.PROVIDER_AGENTKIT === 'off') return undefined;
  const decl = declareAgentkitExtension({
    statement: 'Klero: this agent is backed by a real human (World AgentKit)',
    network: AGENTKIT_CHAIN,
    resourceUri: ENDPOINT,
    expirationSeconds: CHALLENGE_TTL_S,
  }).agentkit;
  const ext = (await agentkitResourceServerExtension.enrichPaymentRequiredResponse!(decl, {
    resourceInfo: { url: ENDPOINT },
    requirements: [],
  } as never)) as { info: { nonce: string } };
  sweep();
  issued.set(ext.info.nonce, Date.now() + (CHALLENGE_TTL_S + 60) * 1000);
  return { agentkit: ext };
}

export type AgentkitCheck =
  | { ok: true; humanId: string | null; address: string | null }
  | { ok: false; code: 'NOT_HUMAN_BACKED'; message: string };

const fail = (message: string): AgentkitCheck => ({ ok: false, code: 'NOT_HUMAN_BACKED', message });

/** Fence step: check the relayed `agentkit` header for the winning `agent` (lowercase 0x address). */
export async function checkAgentkit(header: string | undefined, agent: string): Promise<AgentkitCheck> {
  const mode = env.PROVIDER_AGENTKIT;
  if (mode === 'off') return { ok: true, humanId: null, address: null };
  if (!header) {
    return mode === 'require'
      ? fail('missing agentkit header (World AgentKit proof that the agent is human-backed)')
      : { ok: true, humanId: null, address: null };
  }
  let payload;
  try {
    payload = parseAgentkitHeader(header);
  } catch {
    return fail('malformed agentkit header');
  }
  const message = await validateAgentkitMessage(payload, ENDPOINT, { checkNonce: consumeNonce });
  if (!message.valid) return fail(`agentkit message rejected: ${message.error ?? 'invalid'}`);
  const sig = await verifyAgentkitSignature(payload);
  if (!sig.valid || !sig.address) return fail(`agentkit signature invalid: ${sig.error ?? 'unknown'}`);
  const address = sig.address.toLowerCase();
  if (address !== agent) return fail('agentkit was signed by a different wallet than the winning agent');
  const humanId = await agentBook.lookupHuman(sig.address);
  if (!humanId && mode === 'require') return fail('agent wallet is not registered in World AgentBook');
  return { ok: true, humanId, address };
}
