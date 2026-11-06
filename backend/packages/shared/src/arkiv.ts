import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq } from '@arkiv-network/sdk/query';
import { defineSchema, key, str, u64 } from '@arkiv-network/sdk/schema';
import { http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CAPABILITY, SCHEMA_AGENTLINK, SCHEMA_CLAIM, SCHEMA_SERVICE } from './constants';

export { ExpirationTime, and, eq, u64 };

export const ServiceSchema = defineSchema(SCHEMA_SERVICE, {
  providerId: str().indexed(),
  capability: str().indexed(),
  network: str().indexed(),
  asset: str().indexed(),
  price: u64().indexed(),
  name: str(),
  endpoint: str(),
  payTo: str(),
});

export const AgentLinkSchema = defineSchema(SCHEMA_AGENTLINK, {
  human: str().indexed(),
  agent: str().indexed(),
  status: str().indexed(),
  epoch: u64().indexed(),
  acct: str(),
  label: str(),
});

export const ClaimSchema = defineSchema(SCHEMA_CLAIM, {
  job: str().indexed(),
  round: u64().indexed(),
  human: str().indexed(),
  agent: str().indexed(),
  status: str().indexed(),
  epoch: u64(),
  svc: str(),
  price: u64(),
  seq: u64(),
  tx: str(),
});

export function arkivPublic(accessKey: string) {
  return createPublicClient({ chain: rabdi({ accessKey }), transport: http() });
}

export function arkivWallet(accessKey: string, privateKey: `0x${string}`) {
  return createWalletClient({ chain: rabdi({ accessKey }), transport: http(), account: privateKeyToAccount(privateKey) });
}

export type ArkivPublic = ReturnType<typeof arkivPublic>;
export type ArkivWallet = ReturnType<typeof arkivWallet>;

/** Arkiv typed values come back as { type, value }; normalize to plain JS. */
const s = (v: { value: unknown } | undefined) => String(v?.value ?? '');
const n = (v: { value: unknown } | undefined) => BigInt((v?.value as bigint | number | string | undefined) ?? 0);

export type ServiceRow = {
  key: string;
  owner: string;
  expiresAt: bigint;
  providerId: string;
  capability: string;
  network: string;
  asset: string;
  price: bigint;
  name: string;
  endpoint: string;
  payTo: string;
};

export async function listServices(pub: ArkivPublic, capability = CAPABILITY): Promise<ServiceRow[]> {
  const res = await pub
    .select({
      $key: true,
      $owner: true,
      $expiresAt: true,
      providerId: true,
      capability: true,
      network: true,
      asset: true,
      price: true,
      name: true,
      endpoint: true,
      payTo: true,
    })
    .from(ServiceSchema)
    .where(eq('capability', capability))
    .limit(100)
    .fetch();
  return res.entities.map((e) => ({
    key: String(e.$key),
    owner: String(e.$owner).toLowerCase(),
    expiresAt: BigInt(e.$expiresAt),
    providerId: s(e.providerId),
    capability: s(e.capability),
    network: s(e.network),
    asset: s(e.asset),
    price: n(e.price),
    name: s(e.name),
    endpoint: s(e.endpoint),
    payTo: s(e.payTo),
  }));
}

export type AgentLinkRow = {
  key: string;
  owner: string;
  human: string;
  agent: string;
  status: string;
  epoch: number;
  acct: string;
  label: string;
};

export async function getAgentLink(pub: ArkivPublic, agent: string, owner: string): Promise<AgentLinkRow | null> {
  const res = await pub
    .select({ $key: true, $owner: true, human: true, agent: true, status: true, epoch: true, acct: true, label: true })
    .from(AgentLinkSchema)
    .where(eq('agent', agent.toLowerCase()))
    .ownedBy(owner as `0x${string}`)
    .limit(10)
    .fetch();
  const e = res.entities[0];
  if (!e) return null;
  return {
    key: String(e.$key),
    owner: String(e.$owner).toLowerCase(),
    human: s(e.human),
    agent: s(e.agent),
    status: s(e.status),
    epoch: Number(n(e.epoch)),
    acct: s(e.acct),
    label: s(e.label),
  };
}

export type ClaimRow = {
  key: string;
  owner: string;
  expiresAt: bigint;
  job: string;
  round: number;
  human: string;
  agent: string;
  status: string;
  epoch: number;
  svc: string;
  price: bigint;
  seq: number;
  tx: string;
};

const CLAIM_FIELDS = {
  $key: true,
  $owner: true,
  $expiresAt: true,
  job: true,
  round: true,
  human: true,
  agent: true,
  status: true,
  epoch: true,
  svc: true,
  price: true,
  seq: true,
  tx: true,
} as const;

function toClaim(e: Record<string, any>): ClaimRow {
  return {
    key: String(e.$key),
    owner: String(e.$owner).toLowerCase(),
    expiresAt: BigInt(e.$expiresAt),
    job: s(e.job),
    round: Number(n(e.round)),
    human: s(e.human),
    agent: s(e.agent),
    status: s(e.status),
    epoch: Number(n(e.epoch)),
    svc: s(e.svc),
    price: n(e.price),
    seq: Number(n(e.seq)),
    tx: s(e.tx),
  };
}

export async function listClaims(pub: ArkivPublic, job: string): Promise<ClaimRow[]> {
  const res = await pub.select(CLAIM_FIELDS).from(ClaimSchema).where(eq('job', job)).limit(100).fetch();
  return res.entities.map((e) => toClaim(e as Record<string, any>));
}

export async function getClaim(pub: ArkivPublic, entityKey: string): Promise<ClaimRow | null> {
  const res = await pub
    .select(CLAIM_FIELDS)
    .from(ClaimSchema)
    .where(eq('$key', key(entityKey as `0x${string}`))) // key() typed value, as in the SDK README paging example
    .limit(1)
    .fetch();
  const e = res.entities[0];
  return e ? toClaim(e as Record<string, any>) : null;
}

/** Seconds per block on Arkiv is 2; lifetimes must be even. */
export function evenSeconds(seconds: number): number {
  const s2 = Math.ceil(seconds);
  return s2 % 2 === 0 ? s2 : s2 + 1;
}
