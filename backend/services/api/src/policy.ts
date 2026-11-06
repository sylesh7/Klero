import { ApiError } from '@forkos/shared';
import { sql } from './db';

export type PolicyDecision = { kind: 'ALLOW' } | { kind: 'NEEDS_APPROVAL'; reason: string };

export async function policyView(humanHash: string) {
  const [p] = await sql<{ cap_per_payment: string; daily_cap: string; allowlist: string[] }[]>`
    select cap_per_payment, daily_cap, allowlist from policies where human_hash = ${humanHash}`;
  return {
    capPerPayment: p?.cap_per_payment ?? '0',
    dailyCap: p?.daily_cap ?? '0',
    allowlist: p?.allowlist ?? [],
    spentToday: await spentToday(humanHash),
  };
}

async function spentToday(humanHash: string): Promise<string> {
  const [s] = await sql<{ spent: string }[]>`
    select coalesce(sum(amount), 0)::text as spent from intents
     where human_hash = ${humanHash} and created_at >= date_trunc('day', now())
       and status in ('CREATED','SENT','PAYMENT_UNKNOWN','PAID','DONE')`;
  return s?.spent ?? '0';
}

/** Throws POLICY_DENIED (hard limits) or returns ALLOW / NEEDS_APPROVAL (autonomous cap). */
export async function checkPolicy(humanHash: string, providerId: string, amount: bigint): Promise<PolicyDecision> {
  const p = await policyView(humanHash);
  if (!p.allowlist.includes(providerId)) throw new ApiError('POLICY_DENIED', `provider ${providerId} is not in your allowlist`);
  if (BigInt(p.spentToday) + amount > BigInt(p.dailyCap)) throw new ApiError('POLICY_DENIED', 'daily cap would be exceeded');
  if (amount > BigInt(p.capPerPayment)) return { kind: 'NEEDS_APPROVAL', reason: `amount ${amount} > autonomous cap ${p.capPerPayment}` };
  return { kind: 'ALLOW' };
}

export async function updatePolicy(humanHash: string, patch: { capPerPayment?: string; dailyCap?: string; allowlist?: string[] }) {
  await sql`
    update policies set
      cap_per_payment = coalesce(${patch.capPerPayment ?? null}::bigint, cap_per_payment),
      daily_cap       = coalesce(${patch.dailyCap ?? null}::bigint, daily_cap),
      allowlist       = coalesce(${patch.allowlist ?? null}::text[], allowlist),
      updated_at = now()
    where human_hash = ${humanHash}`;
  return policyView(humanHash);
}
