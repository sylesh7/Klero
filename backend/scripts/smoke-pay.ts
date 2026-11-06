// The proof. Run with the facilitator up (pnpm dev:facilitator).
import { readFileSync } from 'node:fs';
import { Transaction } from '@hiero-ledger/sdk';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { clientFor, hashscan, loadDeployments, Mirror, parsePrivateKey } from '../packages/shared/src/index';
import { buildIntentPayment, resolveIntent } from '../packages/x402-hedera/src/index';

const dep = loadDeployments();
const secrets = JSON.parse(readFileSync('.secrets/testnet-keys.json', 'utf8'));
const payerId = dep.baselineAgents[0]!;
const payerKey = (secrets.baselineAgents?.[payerId] ??
  Object.entries(secrets.flat as Record<string, string>).find(([k]) => k.endsWith(`:${payerId}`))?.[1]) as string;
if (!payerKey) throw new Error(`no key for baseline payer ${payerId}`);
const fac = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL ?? 'http://localhost:4020' });
const mirror = new Mirror(process.env.MIRROR_URL);

const supported = await fac.getSupported();
const feePayer = supported.kinds.find((k) => k.network === 'hedera:testnet')?.extra?.feePayer as string;
const req: PaymentRequirements = {
  scheme: 'exact',
  network: 'hedera:testnet',
  asset: dep.token.id,
  amount: '1000', // 0.001 FUSD
  payTo: dep.providers['scribe-a']!.accountId,
  maxTimeoutSeconds: 180,
  extra: { feePayer },
};
const pr: PaymentRequired = { x402Version: 2, resource: { url: 'smoke://pay' }, accepts: [req] };

async function intent(nowOffsetMs = 0) {
  return buildIntentPayment(pr, req, {
    accountId: payerId,
    privateKey: payerKey,
    memo: `forkos:smoke${Date.now().toString(16).slice(-11)}:r0`.slice(0, 100),
    nowMs: () => Date.now() + nowOffsetMs,
    persist: async (i) => console.log('  persisted BEFORE send:', i.txId, 'deadline', i.deadlineS),
  });
}

// Direct network submission (bypassing every facilitator) to show what Hedera itself says.
async function networkSays(b64: string): Promise<string> {
  const client = clientFor(dep.facilitatorFeePayerId, process.env.FACILITATOR_FEE_PAYER_KEY!);
  try {
    const tx = Transaction.fromBytes(Buffer.from(b64, 'base64'));
    const signed = await tx.sign(parsePrivateKey(process.env.FACILITATOR_FEE_PAYER_KEY!));
    const resp = await signed.execute(client);
    return (await resp.getReceipt(client)).status.toString();
  } catch (err) {
    const status = (err as { status?: { toString(): string } }).status;
    return status ? status.toString() : (err as Error).message;
  } finally {
    client.close();
  }
}

console.log('1) settle a fresh intent through our facilitator');
const a = await intent();
const v = await fac.verify(a.payload, req);
console.log('  verify:', v.isValid, v.invalidReason ?? '');
const s = await fac.settle(a.payload, req);
console.log('  settle:', s.success, s.transaction, s.errorReason ?? '');
await new Promise((r) => setTimeout(r, 6000));
const st = await resolveIntent(mirror, a.intent.txId, a.intent.deadlineS);
console.log('  resolver:', st);
if (st.state === 'PAID') console.log('  HashScan:', hashscan.tx(st.consensusTimestamp));

console.log('2) replay the same payload through our facilitator');
const s2 = await fac.settle(a.payload, req);
console.log('  settle:', s2.success, s2.errorReason);

console.log('3) resubmit the same bytes straight to the network');
console.log('  network:', await networkSays(a.intent.transactionBase64));

console.log('4) an intent whose clock already ran out (valid start 130 s ago)');
const old = await intent(-130_000);
console.log('  facilitator verify:', (await fac.verify(old.payload, req)).invalidReason);
console.log('  network:', await networkSays(old.intent.transactionBase64));

console.log('5) an intent that is never sent → resolver after deadline + 45 s');
const never = await intent(-170_000);
console.log('  resolver:', await resolveIntent(mirror, never.intent.txId, never.intent.deadlineS));
