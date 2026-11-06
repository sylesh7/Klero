// Tops up every baseline-lane wallet (deployments.baselineAgents) to at least <fusd> FUSD from the treasury.
// Usage: tsx --env-file=.env scripts/topup-baseline.ts [fusd=20]   (Windows: scripts\win\topup-baseline.ps1)
import { TransferTransaction } from '@hiero-ledger/sdk';
import { clientFor, loadDeployments, Mirror, parsePrivateKey } from '@forkos/shared';

const target = BigInt(Number(process.argv[2] ?? 20) * 1e6);
const dep = loadDeployments();
const op = process.env.OPERATOR_ID!;
const token = process.env.PAY_ASSET!;
const mirror = new Mirror(process.env.MIRROR_URL);
const client = clientFor(op, parsePrivateKey(process.env.OPERATOR_KEY!));

const tx = new TransferTransaction();
let total = 0n;
for (const acct of dep.baselineAgents) {
  const have = await mirror.tokenBalance(acct, token);
  const need = target > have ? target - have : 0n;
  console.log(`${acct}: ${Number(have) / 1e6} FUSD${need ? ` -> +${Number(need) / 1e6}` : ' (ok)'}`);
  if (need) {
    tx.addTokenTransfer(token, acct, Number(need));
    total += need;
  }
}
if (total === 0n) {
  console.log('all baseline wallets already have enough FUSD');
} else {
  tx.addTokenTransfer(token, op, -Number(total));
  const resp = await tx.execute(client);
  const receipt = await resp.getReceipt(client);
  console.log(`top-up ${receipt.status.toString()} ${resp.transactionId.toString()} (${Number(total) / 1e6} FUSD)`);
}
client.close();
