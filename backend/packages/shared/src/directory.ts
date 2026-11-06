// Service directory on Hedera HCS. Each provider announces itself with a SERVICE message submitted by its own
// account; the directory is the latest SERVICE per provider. An entry is trusted only if the message payer AND
// its payTo are the provider account registered in deployments/testnet.json — anyone can write to the public
// topic, but nobody else can list "scribe-a" with their own payout account.
import { CAPABILITY, NETWORK } from './constants';
import type { Decoded } from './hcs';

export type ServiceRow = {
  providerId: string;
  name: string;
  capability: string;
  network: string;
  asset: string;
  price: bigint;
  endpoint: string;
  payTo: string;
  seq: number; // HCS sequence number of the SERVICE message
  cts: string; // its consensus timestamp
};

/** providerId -> registered Hedera account (from deployments.providers). */
export type ProviderAccounts = Record<string, string>;

export function directoryFrom(messages: Decoded[], providers: ProviderAccounts, capability = CAPABILITY): ServiceRow[] {
  const latest = new Map<string, ServiceRow>();
  for (const d of [...messages].sort((a, b) => a.seq - b.seq)) {
    const m = d.msg;
    if (!m || m.t !== 'SERVICE' || m.cap !== capability) continue;
    const account = providers[m.svc];
    if (!account || d.payer !== account || m.payTo !== account) continue; // unregistered or spoofed
    latest.set(m.svc, {
      providerId: m.svc,
      name: m.name,
      capability: m.cap,
      network: NETWORK,
      asset: m.asset,
      price: BigInt(m.price),
      endpoint: m.url,
      payTo: m.payTo,
      seq: d.seq,
      cts: d.cts,
    });
  }
  return [...latest.values()].sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/** deployments.providers -> ProviderAccounts */
export function providerAccountsOf(providers: Record<string, { accountId: string }>): ProviderAccounts {
  return Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, p.accountId]));
}
