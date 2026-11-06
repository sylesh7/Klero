import { randomBytes } from 'node:crypto';
import { ApiError, formatUnits } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOwner } from '../auth';
import { env } from '../config';
import { mirror } from '../clients';
import { decrypt, encrypt, hashToken, newToken } from '../crypto';
import { sql, type AgentRow, type AttemptRow } from '../db';
import { emit } from '../events';
import { ensureHuman } from '../humans';
import { attemptPublic, onWorldApproved, startDeviceFlow } from '../world';
import { policyView } from '../policy';

export function registerOwnerRoutes(app: FastifyInstance) {
  // LOGIN approved → ensure human + session; token stored sealed in the attempt until the browser fetches it once.
  onWorldApproved('LOGIN', async (row: AttemptRow) => {
    const human = await ensureHuman(row.result_iss!, row.result_sub!);
    const token = newToken('fos');
    await sql`insert into owner_sessions (token_hash, human_hash, expires_at)
              values (${hashToken(token)}, ${human.human_hash}, now() + interval '24 hours')`;
    await sql`update world_attempts set human_hash = ${human.human_hash},
               context = context || ${sql.json({ sessionTokenEnc: encrypt(token) } as never)}, updated_at = now()
               where id = ${row.id}`;
    await emit('approval.resolved', { approvalId: row.id, kind: 'LOGIN', status: 'APPROVED' });
  });

  app.post('/v1/owner/login/start', async () => attemptPublic(await startDeviceFlow('LOGIN')));

  app.get<{ Params: { attemptId: string } }>('/v1/owner/login/:attemptId', async (req) => {
    const [row] = await sql<AttemptRow[]>`select * from world_attempts where id = ${req.params.attemptId} and kind = 'LOGIN'`;
    if (!row) throw new ApiError('NOT_FOUND', 'unknown attempt');
    if (row.status !== 'APPROVED') return { status: row.status, reason: row.reason };
    const sealed = row.context.sessionTokenEnc as string | undefined;
    if (!sealed || !row.human_hash) return { status: 'PENDING' }; // handler still running
    // Hand the token out exactly once.
    await sql`update world_attempts set context = context - 'sessionTokenEnc', updated_at = now() where id = ${row.id}`;
    const [h] = await sql<{ budget_account_id: string }[]>`select budget_account_id from humans where human_hash = ${row.human_hash}`;
    return { status: 'APPROVED', token: decrypt(sealed), human: { humanHash: row.human_hash, budgetAccountId: h!.budget_account_id } };
  });

  app.get('/v1/me', async (req) => {
    const human = await requireOwner(req);
    const [hbar, fusd] = await Promise.all([
      mirror.hbarBalance(human.budget_account_id),
      env.PAY_ASSET === '0.0.0' ? Promise.resolve(0n) : mirror.tokenBalance(human.budget_account_id, env.PAY_ASSET),
    ]);
    const agents = await sql<AgentRow[]>`select * from agents where human_hash = ${human.human_hash} order by linked_at`;
    const [pairing] = await sql<{ code: string; expires_at: Date }[]>`
      select code, expires_at from pairings where human_hash = ${human.human_hash} and used_at is null and expires_at > now()
      order by expires_at desc limit 1`;
    return {
      humanHash: human.human_hash,
      budgetAccountId: human.budget_account_id,
      balance: {
        asset: env.PAY_ASSET,
        amount: fusd.toString(),
        display: formatUnits(fusd, env.PAY_ASSET_DECIMALS),
        hbar: formatUnits(hbar, 8),
      },
      policy: await policyView(human.human_hash),
      agents: agents.map((a) => ({
        agentAddr: a.agent_addr,
        label: a.label,
        accountId: a.account_id,
        epoch: a.epoch,
        status: a.status,
        linkedAt: a.linked_at,
      })),
      pairing: pairing ? { code: pairing.code, expiresAt: pairing.expires_at } : null,
      world: { subStable: env.WORLD_SUB_STABLE },
    };
  });

  app.post('/v1/pairings', async (req) => {
    const human = await requireOwner(req);
    const { label } = z.object({ label: z.string().min(1).max(40) }).parse(req.body ?? {});
    const code = randomBytes(4).toString('hex').toUpperCase(); // 8 chars, shown on the dashboard
    const [row] = await sql<{ code: string; expires_at: Date }[]>`
      insert into pairings (code, human_hash, label, expires_at) values (${code}, ${human.human_hash}, ${label}, now() + interval '15 minutes')
      returning code, expires_at`;
    return { code: row!.code, expiresAt: row!.expires_at };
  });
}
