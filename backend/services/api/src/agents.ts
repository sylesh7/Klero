import { ApiError, digestOf, publishHcs } from '@forkos/shared';
import { AccountCreateTransaction, Hbar, PublicKey } from '@hiero-ledger/sdk';
import { env } from './config';
import { hedera } from './clients';
import { encrypt, hashToken, newToken } from './crypto';
import { sql, type AgentRow } from './db';
import { emit } from './events';
import { publishApproval } from './humans';

/** The ECDSA public key must derive the claimed EVM address (the agent's one key = its Hedera account key). */
export function assertKeyMatchesAddress(publicKeyHex: string, agentAddr: string) {
  let derived: string;
  try {
    derived = PublicKey.fromStringECDSA(publicKeyHex.replace(/^0x/, '')).toEvmAddress().toLowerCase().replace(/^0x/, '');
  } catch {
    throw new ApiError('BAD_REQUEST', 'publicKeyHex is not a valid ECDSA public key');
  }
  if (`0x${derived}` !== agentAddr.toLowerCase()) throw new ApiError('BAD_REQUEST', 'publicKeyHex does not match agentAddr');
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

  // 2. HCS LINK (ordered, public): the source of truth providers read.
  const { seq } = await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'LINK', human: input.humanHash, agent: agentAddr, acct: accountId, epoch });
  await publishApproval(input.humanHash, 'LINK', digestOf({ kind: 'LINK', human: input.humanHash, agent: agentAddr, epoch }));

  // 3. DB row + token.
  await sql`
    insert into agents (agent_addr, human_hash, label, account_id, public_key_hex, epoch, status, link_seq)
    values (${agentAddr}, ${input.humanHash}, ${input.label}, ${accountId}, ${input.publicKeyHex}, ${epoch}, 'ACTIVE', ${seq})
    on conflict (agent_addr) do update set epoch = ${epoch}, status = 'ACTIVE', label = ${input.label},
      link_seq = ${seq}, linked_at = now(), revoked_at = null`;
  await sql`update agent_tokens set revoked_at = now() where agent_addr = ${agentAddr} and revoked_at is null`;
  const token = newToken('fat');
  await sql`insert into agent_tokens (token_hash, agent_addr, epoch) values (${hashToken(token)}, ${agentAddr}, ${epoch})`;

  await emit('agent.linked', { humanHash: input.humanHash, agentAddr, label: input.label, accountId, epoch });
  return { token, sealed: encrypt(token), accountId, epoch };
}
