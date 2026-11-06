// Creates accounts, the FUSD token and the referee/audit topic on Hedera testnet.
// Usage: pnpm bootstrap:hedera            (refuses to overwrite)
//        pnpm bootstrap:hedera --force
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  AccountCreateTransaction,
  Hbar,
  PrivateKey,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
  TopicCreateTransaction,
  TransferTransaction,
} from '@hiero-ledger/sdk';
import { clientFor, ecdsaKeyToHex, hashscan, parsePrivateKey } from '../packages/shared/src/hedera';

const must = (k: string) => {
  const v = process.env[k];
  if (!v || v.startsWith('<')) throw new Error(`Missing ${k} in .env`);
  return v;
};

const DEPLOY = 'deployments/testnet.json';
const SECRETS = '.secrets/testnet-keys.json';
if (existsSync(DEPLOY) && !process.argv.includes('--force')) {
  throw new Error(`${DEPLOY} exists. Re-run with --force only if you really want NEW accounts/token/topic.`);
}

const operatorId = must('OPERATOR_ID');
const operatorKey = parsePrivateKey(must('OPERATOR_KEY'));
const client = clientFor(operatorId, operatorKey);

mkdirSync('deployments', { recursive: true });
mkdirSync('.secrets', { recursive: true });

/**
 * Crash safety: every generated key is appended to .secrets/testnet-keys.json the moment its
 * account exists on-chain. The naive version keeps all keys in memory and writes once at the end,
 * so any interruption past the first account leaves funded accounts on testnet whose keys are
 * gone forever (learned the hard way: 171 HBAR orphaned that way).
 */
const keyLog: Record<string, string> = existsSync(SECRETS)
  ? (JSON.parse(readFileSync(SECRETS, 'utf8')) as { flat?: Record<string, string> }).flat ?? {}
  : {};

function recordKey(label: string, id: string, keyHex: string) {
  keyLog[`${label}:${id}`] = keyHex;
  writeFileSync(SECRETS, JSON.stringify({ flat: keyLog }, null, 2) + '\n', { mode: 0o600 });
}

async function newAccount(label: string, hbar: number) {
  const key = PrivateKey.generateECDSA();
  const keyHex = ecdsaKeyToHex(key);
  const resp = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(hbar))
    .setMaxAutomaticTokenAssociations(-1)
    .execute(client);
  const receipt = await resp.getReceipt(client);
  const id = receipt.accountId!.toString();
  recordKey(label, id, keyHex); // persisted BEFORE we move on
  console.log(`  ${label.padEnd(18)} ${id}  ${hashscan.account(id)}`);
  return { id, key: keyHex };
}

console.log('1/4 accounts');
const facilitator = await newAccount('facilitator', 100);
const providers = {
  'scribe-a': { ...(await newAccount('scribe-a', 20)), price: '50000', name: 'Scribe A' },
  'scribe-b': { ...(await newAccount('scribe-b', 20)), price: '40000', name: 'Scribe B' },
  'scribe-premium': { ...(await newAccount('scribe-premium', 20)), price: '2000000', name: 'Scribe Premium' },
};
const baseline = [await newAccount('baseline-1', 2), await newAccount('baseline-2', 2), await newAccount('baseline-3', 2)];

console.log('2/4 FUSD token');
const tokenResp = await new TokenCreateTransaction()
  .setTokenName('ForkOS Test USD')
  .setTokenSymbol('FUSD')
  .setDecimals(6)
  .setInitialSupply(1_000_000_000_000) // 1,000,000 FUSD
  .setTreasuryAccountId(operatorId)
  .setAdminKey(operatorKey.publicKey)
  .setSupplyKey(operatorKey.publicKey)
  .setTokenType(TokenType.FungibleCommon)
  .setSupplyType(TokenSupplyType.Infinite)
  .execute(client);
const tokenId = (await tokenResp.getReceipt(client)).tokenId!.toString();
console.log(`  FUSD ${tokenId}  ${hashscan.token(tokenId)}`);

console.log('3/4 fund baseline agents with 10 FUSD each');
for (const b of baseline) {
  const r = await new TransferTransaction()
    .addTokenTransfer(tokenId, operatorId, -10_000_000)
    .addTokenTransfer(tokenId, b.id, 10_000_000)
    .execute(client);
  await r.getReceipt(client);
}

console.log('4/4 HCS topic');
const topicResp = await new TopicCreateTransaction()
  .setTopicMemo('ForkOS v1 — referee + audit log')
  .setAdminKey(operatorKey.publicKey)
  .execute(client);
const topicId = (await topicResp.getReceipt(client)).topicId!.toString();
console.log(`  topic ${topicId}  ${hashscan.topic(topicId)}`);

const deployments = {
  network: 'hedera:testnet',
  createdAt: new Date().toISOString(),
  operatorId,
  token: { id: tokenId, symbol: 'FUSD', decimals: 6 },
  topicId,
  facilitatorFeePayerId: facilitator.id,
  providers: Object.fromEntries(
    Object.entries(providers).map(([k, p]) => [k, { accountId: p.id, price: p.price, name: p.name }]),
  ),
  baselineAgents: baseline.map((b) => b.id),
};
const secrets = {
  facilitator: facilitator.key,
  providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, p.key])),
  baselineAgents: Object.fromEntries(baseline.map((b) => [b.id, b.key])),
};

writeFileSync(DEPLOY, JSON.stringify(deployments, null, 2) + '\n');
// Final structured form, keeping the incremental flat log alongside it for recovery.
writeFileSync(SECRETS, JSON.stringify({ ...secrets, flat: keyLog }, null, 2) + '\n', { mode: 0o600 });

console.log('\nAdd to .env:');
console.log(`PAY_ASSET=${tokenId}`);
console.log(`HCS_TOPIC_ID=${topicId}`);
console.log(`FACILITATOR_FEE_PAYER_ID=${facilitator.id}`);
console.log(`FACILITATOR_FEE_PAYER_KEY=<.secrets/testnet-keys.json → facilitator>`);
console.log('\nAdd to .env.scribe-* : PROVIDER_ACCOUNT_ID / PROVIDER_ACCOUNT_KEY from deployments + secrets');
client.close();
