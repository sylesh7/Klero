import { ApiError, publishHcs, zEvmAddr } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertKeyMatchesAddress, linkAgent } from '../agents';
import { consumeApproval, createApproval, setApprovalStatus } from '../approvals';
import { requireAgent, requireOwner } from '../auth';
import { hedera } from '../clients';
import { env } from '../config';
import { decrypt } from '../crypto';
import { sql, type AgentRow, type ApprovalRow, type AttemptRow } from '../db';
import { emit } from '../events';
import { ensureHuman, publishApproval } from '../humans';
import { attemptPublic, onWorldApproved, onWorldNotApproved, startDeviceFlow } from '../world';

const LinkStart = z.object({
  agentAddr: zEvmAddr,
  publicKeyHex: z.string().regex(/^(0x)?[0-9a-fA-F]{66}$|^(0x)?[0-9a-fA-F]{130}$/),
  label: z.string().min(1).max(40),
  pairingCode: z.string().min(4).max(16).optional(),
});

export function registerAgentRoutes(app: FastifyInstance) {
  onWorldApproved('LINK', async (row: AttemptRow) => {
    const ctx = row.context as { agentAddr: string; publicKeyHex: string; label: string; pairingCode?: string };
    let humanHash: string;
    if (env.WORLD_SUB_STABLE) {
      humanHash = (await ensureHuman(row.result_iss!, row.result_sub!)).human_hash;
    } else {
      // pairing mode: fresh World auth succeeded; bind to the owner who created the pairing code
      const [p] = await sql<{ human_hash: string }[]>`
        update pairings set used_at = now() where code = ${ctx.pairingCode ?? ''} and used_at is null and expires_at > now()
        returning human_hash`;
      if (!p) throw new Error('pairing code invalid, used or expired');
      humanHash = p.human_hash;
    }
    const linked = await linkAgent({ humanHash, agentAddr: ctx.agentAddr, publicKeyHex: ctx.publicKeyHex, label: ctx.label });
    await sql`update world_attempts set human_hash = ${humanHash},
               context = context || ${sql.json({ agentTokenEnc: linked.sealed, accountId: linked.accountId, epoch: linked.epoch } as never)},
               updated_at = now() where id = ${row.id}`;
  });

  app.post('/v1/agents/link/start', async (req) => {
    const body = LinkStart.parse(req.body);
    assertKeyMatchesAddress(body.publicKeyHex, body.agentAddr);
    if (!env.WORLD_SUB_STABLE) {
      if (!body.pairingCode) throw new ApiError('BAD_REQUEST', 'pairingCode required (create one on the dashboard)');
      const [p] = await sql`select 1 from pairings where code = ${body.pairingCode} and used_at is null and expires_at > now()`;
      if (!p) throw new ApiError('BAD_REQUEST', 'pairing code invalid, used or expired');
    }
    const attempt = await startDeviceFlow('LINK', { context: body });
    const pub = attemptPublic(attempt);
    return { linkId: pub.attemptId, ...pub };
  });

  app.get<{ Params: { linkId: string } }>('/v1/agents/link/:linkId', async (req) => {
    const [row] = await sql<AttemptRow[]>`select * from world_attempts where id = ${req.params.linkId} and kind = 'LINK'`;
    if (!row) throw new ApiError('NOT_FOUND', 'unknown link attempt');
    if (row.status !== 'APPROVED') return { status: row.status, reason: row.reason };
    const ctx = row.context as { agentTokenEnc?: string; accountId?: string; epoch?: number; agentAddr: string };
    if (!ctx.agentTokenEnc) return { status: 'PENDING' };
    await sql`update world_attempts set context = context - 'agentTokenEnc', updated_at = now() where id = ${row.id}`;
    return {
      status: 'LINKED',
      agentToken: decrypt(ctx.agentTokenEnc),
      agent: { agentAddr: ctx.agentAddr, accountId: ctx.accountId, epoch: ctx.epoch, humanHash: row.human_hash },
    };
  });

  app.get('/v1/agents', async (req) => {
    const human = await requireOwner(req);
    const rows = await sql<AgentRow[]>`select * from agents where human_hash = ${human.human_hash} order by linked_at`;
    return {
      agents: rows.map((a) => ({
        agentAddr: a.agent_addr,
        label: a.label,
        accountId: a.account_id,
        epoch: a.epoch,
        status: a.status,
        linkedAt: a.linked_at,
      })),
    };
  });

  app.get('/v1/me/agent', async (req) => {
    const a = await requireAgent(req);
    return { agentAddr: a.agent_addr, humanHash: a.human_hash, accountId: a.account_id, epoch: a.epoch, status: a.status, label: a.label };
  });

  // ── revoke / replace (P26) ──
  onWorldApproved('REVOKE', async (row: AttemptRow) => {
    const approvalId = (row.context as { approvalId: string }).approvalId;
    const approval = await setApprovalStatus(approvalId, 'APPROVED');
    if (approval) await executeRevoke(approval);
  });
  onWorldNotApproved('REVOKE', async (row: AttemptRow) => {
    const approvalId = (row.context as { approvalId: string }).approvalId;
    await setApprovalStatus(approvalId, row.status === 'EXPIRED' ? 'EXPIRED' : 'DENIED');
  });

  app.post<{ Params: { agentAddr: string } }>('/v1/agents/:agentAddr/revoke/start', async (req) => {
    const human = await requireOwner(req);
    const agentAddr = req.params.agentAddr.toLowerCase();
    const [a] = await sql<AgentRow[]>`select * from agents where agent_addr = ${agentAddr} and human_hash = ${human.human_hash}`;
    if (!a) throw new ApiError('NOT_FOUND', 'agent not found for this owner');
    if (a.status !== 'ACTIVE') throw new ApiError('BAD_REQUEST', 'agent already revoked');
    const action = { kind: 'REVOKE', human: human.human_hash, agent: agentAddr, fromEpoch: a.epoch };
    return createApproval(human.human_hash, human.sub, 'REVOKE', action);
  });

  app.get<{ Params: { approvalId: string } }>('/v1/approvals/:approvalId', async (req) => {
    const human = await requireOwner(req);
    const [a] = await sql<ApprovalRow[]>`select * from approvals where id = ${req.params.approvalId} and human_hash = ${human.human_hash}`;
    if (!a) throw new ApiError('NOT_FOUND', 'unknown approval');
    return { approvalId: a.id, kind: a.kind, status: a.status, action: a.action, digest: a.digest, expiresAt: a.expires_at };
  });

  app.post<{ Params: { approvalId: string } }>('/v1/approvals/:approvalId/cancel', async (req) => {
    const human = await requireOwner(req);
    const [a] = await sql<ApprovalRow[]>`select * from approvals where id = ${req.params.approvalId} and human_hash = ${human.human_hash}`;
    if (!a) throw new ApiError('NOT_FOUND', 'unknown approval');
    await setApprovalStatus(a.id, 'DENIED');
    return { status: 'DENIED' };
  });
}

async function executeRevoke(approval: ApprovalRow) {
  const action = approval.action as { kind: 'REVOKE'; human: string; agent: string; fromEpoch: number };
  const newEpoch = action.fromEpoch + 1;
  const agent = await sql.begin(async (tx) => {
    await consumeApproval(tx as unknown as typeof sql, approval.id, action);
    const [a] = await tx<AgentRow[]>`select * from agents where agent_addr = ${action.agent} for update`;
    if (!a || a.epoch !== action.fromEpoch || a.status !== 'ACTIVE') throw new ApiError('APPROVAL_MISMATCH', 'agent changed since approval');
    await tx`update agents set status = 'REVOKED', epoch = ${newEpoch}, revoked_at = now() where agent_addr = ${action.agent}`;
    await tx`update agent_tokens set revoked_at = now() where agent_addr = ${action.agent} and revoked_at is null`;
    return a;
  });
  await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'REVOKE', human: action.human, agent: action.agent, epoch: newEpoch });
  await publishApproval(action.human, 'REVOKE', approval.digest);
  await emit('agent.revoked', { humanHash: action.human, agentAddr: action.agent, epoch: newEpoch });
}

