// Proves: write as a wallet, read back through a query, expiry roughly on time.
import { arkivPublic, arkivWallet, ExpirationTime, getClaim, listClaims, ClaimSchema, u64 } from '../packages/shared/src/arkiv';

const accessKey = process.env.ARKIV_ACCESS_KEY!;
// Any funded wallet. FORKOS_AGENT_KEY is funded by the API at link time (AGENT_ARKIV_FUND_WEI),
// so for a standalone smoke we use the provider wallet, which the faucet funded directly.
const key = (process.env.SMOKE_ARKIV_KEY ?? process.env.PROVIDER_ARKIV_KEY) as `0x${string}`;
const pub = arkivPublic(accessKey);
const wallet = arkivWallet(accessKey, key);
console.log('wallet', wallet.account.address);

const job = 'ab'.repeat(32);
const t0 = Date.now();
const created = await wallet.createEntity(
  ClaimSchema,
  {
    job,
    round: u64(0),
    human: 'cd'.repeat(32),
    agent: wallet.account.address.toLowerCase(),
    status: 'OPEN',
    epoch: u64(1),
    svc: 'smoke',
    price: u64(1),
    seq: u64(0),
    tx: '-',
  },
  { expiration: ExpirationTime.fromSeconds(30) },
);
console.log('created', created.entityKey, 'tx', created.txHash, 'expiresAt block', created.expiresAt, 'in', Date.now() - t0, 'ms');

console.log('by job:', (await listClaims(pub, job)).map((c) => ({ key: c.key, status: c.status, owner: c.owner })));
console.log('by key:', (await getClaim(pub, created.entityKey))?.status);

await wallet.patchEntity(ClaimSchema, created.entityKey, { set: { status: 'WON' } });
console.log('after patch:', (await getClaim(pub, created.entityKey))?.status);

console.log('waiting 40 s for expiry…');
await new Promise((r) => setTimeout(r, 40_000));
console.log('after expiry (expect 0):', (await listClaims(pub, job)).length);
