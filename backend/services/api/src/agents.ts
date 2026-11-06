import { ApiError, ExpirationTime, AgentLinkSchema, digestOf, getAgentLink, publishHcs, u64 } from '@forkos/shared';
import { AccountCreateTransaction, Hbar, PublicKey } from '@hiero-ledger/sdk';
import { env } from './config';
import { API_ARKIV_ADDRESS, arkivApi, arkivPub, hedera } from './clients';
import { encrypt, hashToken, newToken } from './crypto';
import { sql, type AgentRow } from './db';
import { emit } from './events';
import { publishApproval } from './humans';

/** The ECDSA public key must derive the claimed EVM address (one key = Hedera account + Arkiv wallet). */
export function assertKeyMatchesAddress(publicKeyHex: string, agentAddr: string) {
  let derived: string;
  try {
    derived = PublicKey.fromStringECDSA(publicKeyHex.replace(/^0x/, '')).toEvmAddress().toLowerCase().replace(/^0x/, '');
  } catch {
    throw new ApiError('BAD_REQUEST', 'publicKeyHex is not a valid ECDSA public key');
  }
  if (`0x${derived}` !== agentAddr.toLowerCase()) throw new ApiError('BAD_REQUEST', 'publicKeyHex does not match agentAddr');
}

export async function upsertAgentLinkEntity(row: { human: string; agent: string; status: 'ACTIVE' | 'REVOKED'; epoch: number; acct: string; label: string }) {
  const values = { human: row.human, agent: row.agent, status: row.status, epoch: u64(row.epoch), acct: row.acct, label: row.label };
  const existing = await getAgentLink(arkivPub, row.agent, API_ARKIV_ADDRESS);
  if (existing) {
    const key = existing.key as `0x${string}`;
    await arkivApi.patchEntity(AgentLinkSchema, key, { set: values });
    await arkivApi.extendEntity({ entityKey: key, expiration: ExpirationTime.atDate(new Date(Date.now() + 30 * 86_400_000)) });
    return existing.key;
  }
  const created = await arkivApi.createEntity(AgentLinkSchema, values, { expiration: ExpirationTime.fromDays(30) });
  return created.entityKey;
}

/** Links (or re-links) an agent to a human. Returns the agent token (shown once). */
export async function linkAgent(input: { humanHash: string; agentAddr: string; publicKeyHex: string; label: string }) {
  const agentAddr = input.agentAddr.toLowerCase();
  const [prev] = await sql<AgentRow[]>`select * from agents where agent_addr = ${agentAddr}`;
  if (prev && prev.human_hash !== input.humanHash) throw new ApiError('FORBIDDEN', 'agent already belongs to another human');
  const epoch = prev ? prev.epoch + 1 : 1;

  // 1. Hedera account owned by the agent's own key (re-used on re-link).
  let accountId = prev?.account_id;
  if (!accountId) {
    const resp = await new AccountCreateTransaction()
      .setKeyWithoutAlias(PublicKey.fromStringECDSA(input.publicKeyHex.replace(/^0x/, '')))
      .setInitialBalance(new Hbar(env.AGENT_HBAR_FUND))
      .execute(hedera);
    accountId = (await resp.getReceipt(hedera)).accountId!.toString();
  }

  // 2. A little tGLM so the agent can write its own Arkiv claims.
  if (!prev) {
    await arkivApi.sendTransaction({ to: agentAddr as `0x${string}`, value: BigInt(env.AGENT_ARKIV_FUND_WEI) } as never);
  }

  // 3. HCS LINK (ordered, public) then Arkiv AgentLink (live state providers read).
  const { seq } = await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'LINK', human: input.humanHash, agent: agentAddr, acct: accountId, epoch });
  const arkivKey = await upsertAgentLinkEntity({ human: input.humanHash, agent: agentAddr, status: 'ACTIVE', epoch, acct: accountId, label: input.label });
  await publishApproval(input.humanHash, 'LINK', digestOf({ kind: 'LINK', human: input.humanHash, agent: agentAddr, epoch }));

  // 4. DB row + token.
  await sql`
    insert into agents (agent_addr, human_hash, label, account_id, public_key_hex, epoch, status, arkiv_key, link_seq)
    values (${agentAddr}, ${input.humanHash}, ${input.label}, ${accountId}, ${input.publicKeyHex}, ${epoch}, 'ACTIVE', ${arkivKey}, ${seq})
    on conflict (agent_addr) do update set epoch = ${epoch}, status = 'ACTIVE', label = ${input.label}, arkiv_key = ${arkivKey},
      link_seq = ${seq}, linked_at = now(), revoked_at = null`;
  await sql`update agent_tokens set revoked_at = now() where agent_addr = ${agentAddr} and revoked_at is null`;
  const token = newToken('fat');
  await sql`insert into agent_tokens (token_hash, agent_addr, epoch) values (${hashToken(token)}, ${agentAddr}, ${epoch})`;

  await emit('agent.linked', { humanHash: input.humanHash, agentAddr, label: input.label, accountId, epoch });
  return { token, sealed: encrypt(token), accountId, epoch, arkivKey };
}
