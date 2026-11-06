import { APPROVAL_TTL_S, ApiError, digestOf } from '@forkos/shared';
import { newId } from './crypto';
import { sql, type ApprovalRow } from './db';
import { emit } from './events';
import { attemptPublic, startDeviceFlow } from './world';

/** Creates a PENDING approval bound to `action` (digest) and starts the World step-up for it. */
export async function createApproval(
  humanHash: string,
  sub: string,
  kind: 'REVOKE' | 'OVERCAP',
  action: Record<string, unknown>,
) {
  const digest = digestOf(action);
  const id = newId('ap');
  const attempt = await startDeviceFlow(kind, { expectedSub: sub, humanHash, context: { approvalId: id } });
  await sql`
    insert into approvals (id, human_hash, kind, status, action, digest, world_attempt_id, expires_at)
    values (${id}, ${humanHash}, ${kind}, 'PENDING', ${sql.json(action as never)}, ${digest}, ${attempt.id},
            now() + make_interval(secs => ${APPROVAL_TTL_S}))`;
  const pub = attemptPublic(attempt);
  await emit('approval.pending', {
    approvalId: id,
    kind,
    humanHash,
    action,
    userCode: pub.userCode,
    verificationUriComplete: pub.verificationUriComplete,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_S * 1000).toISOString(),
  });
  return { approvalId: id, digest, ...pub };
}

/**
 * Atomically consumes an APPROVED approval for exactly this action. Throws if missing, expired, used,
 * or bound to a different action (APPROVAL_MISMATCH). Must be called inside the caller's transaction.
 */
export async function consumeApproval(tx: typeof sql, approvalId: string, action: Record<string, unknown>): Promise<ApprovalRow> {
  const [a] = await tx<ApprovalRow[]>`select * from approvals where id = ${approvalId} for update`;
  if (!a) throw new ApiError('NOT_FOUND', 'unknown approval');
  if (a.digest !== digestOf(action)) throw new ApiError('APPROVAL_MISMATCH', 'approval was given for a different action');
  if (a.status === 'USED') throw new ApiError('APPROVAL_MISMATCH', 'approval already used');
  if (a.status !== 'APPROVED') throw new ApiError('FORBIDDEN', `approval is ${a.status}`);
  if (a.expires_at.getTime() < Date.now()) throw new ApiError('APPROVAL_EXPIRED', 'approval expired');
  const [used] = await tx<ApprovalRow[]>`update approvals set status = 'USED', used_at = now() where id = ${approvalId} returning *`;
  return used!;
}

export async function setApprovalStatus(approvalId: string, status: 'APPROVED' | 'DENIED' | 'EXPIRED') {
  const [a] = await sql<ApprovalRow[]>`update approvals set status = ${status} where id = ${approvalId} and status = 'PENDING' returning *`;
  if (a) await emit('approval.resolved', { approvalId, kind: a.kind, status });
  return a ?? null;
}
