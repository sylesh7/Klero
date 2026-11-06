// World AgentKit, agent side: prove this agent's wallet is backed by a real human (World AgentBook).
// The provider puts an `extensions.agentkit` challenge in its x402 402 response; the agent signs it (SIWE, EIP-191)
// with its own key — the same key as its Hedera account — and hands the header to the Klero API, which only
// relays it. Payment stays on Hedera; World Chain is only the chain the SIWE message names.
import { H_AGENT, H_JOB, H_ROUND, type ServiceRow } from '@forkos/shared';
import { createAgentkitClient, type AgentkitClient } from '@worldcoin/agentkit';
import { privateKeyToAccount } from 'viem/accounts';

export const AGENTKIT_CHAIN = 'eip155:480'; // World Chain, where AgentBook lives

export function agentkitClient(key: `0x${string}`): AgentkitClient {
  const account = privateKeyToAccount(key);
  return createAgentkitClient({
    signer: { address: account.address, chainId: AGENTKIT_CHAIN, type: 'eip191', signMessage: (message) => account.signMessage({ message }) },
  });
}

/**
 * Fetch the provider's challenge for this job round and sign it. Returns undefined when the provider does not
 * ask for AgentKit (mode off) or the challenge can't be fetched — the payment still proceeds and the provider
 * decides (in `require` mode it refuses without a header).
 */
export async function agentkitHeaderFor(
  client: AgentkitClient,
  svc: ServiceRow,
  job: { jobKey: string; audioUrl: string; inputHash: string },
  round: number,
  agentAddr: string,
): Promise<string | undefined> {
  const res = await fetch(svc.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [H_JOB]: job.jobKey, [H_ROUND]: String(round), [H_AGENT]: agentAddr },
    body: JSON.stringify({ audioUrl: job.audioUrl, inputHash: job.inputHash }),
  });
  if (res.status !== 402) return undefined; // e.g. 409 from the fence — the payer will surface that
  const pr = (await res.json().catch(() => null)) as { extensions?: { agentkit?: unknown } } | null;
  const ext = pr?.extensions?.agentkit;
  if (!ext) return undefined;
  return client.createHeader(ext as Parameters<AgentkitClient['createHeader']>[0]);
}
