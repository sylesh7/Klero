import { ApiError } from '@forkos/shared';
import type { FastifyRequest } from 'fastify';
import { env } from './config';
import { hashToken } from './crypto';
import { sql, type AgentRow, type HumanRow } from './db';

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export async function requireOwner(req: FastifyRequest): Promise<HumanRow> {
  const t = bearer(req);
  if (!t || !t.startsWith('fos_')) throw new ApiError('UNAUTHORIZED', 'owner token required');
  const [row] = await sql<HumanRow[]>`
    select h.* from owner_sessions s join humans h on h.human_hash = s.human_hash
     where s.token_hash = ${hashToken(t)} and s.expires_at > now()`;
  if (!row) throw new ApiError('UNAUTHORIZED', 'owner session invalid or expired');
  return row;
}

export async function requireAgent(req: FastifyRequest): Promise<AgentRow> {
  const t = bearer(req);
  if (!t || !t.startsWith('fat_')) throw new ApiError('UNAUTHORIZED', 'agent token required');
  const [row] = await sql<(AgentRow & { token_epoch: number })[]>`
    select a.*, t.epoch as token_epoch from agent_tokens t join agents a on a.agent_addr = t.agent_addr
     where t.token_hash = ${hashToken(t)} and t.revoked_at is null`;
  if (!row) throw new ApiError('UNAUTHORIZED', 'agent token invalid');
  if (row.status !== 'ACTIVE' || row.token_epoch !== row.epoch) {
    throw new ApiError('STALE_AUTHORITY', 'agent revoked or token from an old epoch');
  }
  return row;
}

/** Either an owner (any job of theirs) or an agent (jobs of its human). Returns the human hash. */
export async function requireOwnerOrAgent(req: FastifyRequest): Promise<string> {
  const t = bearer(req);
  if (t?.startsWith('fat_')) return (await requireAgent(req)).human_hash;
  return (await requireOwner(req)).human_hash;
}

export function requireDemo(req: FastifyRequest): void {
  if (req.headers['x-demo-key'] !== env.DEMO_KEY) throw new ApiError('FORBIDDEN', 'demo key required');
}
