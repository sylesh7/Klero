// Usage: pnpm baseline     → 3 independent agents, own wallets, stock x402 client, same meeting
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForkosApi } from '@forkos/agent-kit';
import { loadDeployments, parsePrivateKey, type ServiceRow } from '@forkos/shared';
import { x402Client } from '@x402/core/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { llmChoose, PERSONAS } from './choose';

const dep = loadDeployments();
const secrets = JSON.parse(readFileSync(join(process.cwd(), '..', '..', '.secrets', 'testnet-keys.json'), 'utf8'));
const keyFor = (accountId: string): string =>
  secrets.baselineAgents?.[accountId] ??
  (Object.entries(secrets.flat as Record<string, string>).find(([k]) => k.endsWith(`:${accountId}`))?.[1] as string);
const apiUrl = process.env.FORKOS_API_URL ?? 'http://localhost:4040';
const api = new ForkosApi(apiUrl);
const since = Math.floor(Date.now() / 1000) - 5;
const job = await api.demoJob(process.env.DEMO_KEY!);
const services = (await api.directory()).services.map((s) => ({ ...s, price: BigInt(s.price) })) as unknown as ServiceRow[];

const runs = await Promise.all(
  dep.baselineAgents.map(async (accountId, i) => {
    const signer = createClientHederaSigner(accountId, parsePrivateKey(keyFor(accountId)), { network: 'hedera:testnet' });
    const client = new x402Client().register('hedera:*', new ExactHederaScheme(signer)).setSpendControls(false);
    const pay = wrapFetchWithPayment(fetch, client);
    const svc = await llmChoose(PERSONAS[i % PERSONAS.length]!, services);
    const url = svc.endpoint.replace(/\/v1\/jobs$/, '/v1/baseline/jobs');
    const res = await pay(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) });
    const header = res.headers.get('PAYMENT-RESPONSE');
    const settle = header ? decodePaymentResponseHeader(header) : null;
    return { agent: accountId, provider: svc.providerId, status: res.status, tx: settle?.transaction ?? '-' };
  }),
);
console.table(runs);
console.log('Each independent agent paid. Standard x402 dedupes retries of ONE request, not one job across agents.');
console.log('Mirror counter (baseline lane, since start):');
const counterJob = '0'.repeat(64); // baseline lane does not depend on jobKey
console.log(JSON.stringify((await api.counter(counterJob, since)).baseline));
