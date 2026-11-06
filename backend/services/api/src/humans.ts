import { ecdsaKeyToHex, humanHashOf, publishHcs } from '@forkos/shared';
import { AccountCreateTransaction, Hbar, PrivateKey, TransferTransaction } from '@hiero-ledger/sdk';
import { env, PROVIDER_IDS } from './config';
import { hedera } from './clients';
import { encrypt } from './crypto';
import { sql, type HumanRow } from './db';

/** Finds or creates the human for (iss, sub): budget account funded with FUSD, default policy. */
export async function ensureHuman(iss: string, sub: string): Promise<HumanRow> {
  const humanHash = humanHashOf(iss, sub, env.HUMAN_SALT);
  const [existing] = await sql<HumanRow[]>`select * from humans where human_hash = ${humanHash}`;
  if (existing) return existing;

  const key = PrivateKey.generateECDSA();
  const created = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(env.HUMAN_HBAR_FUND))
    .setMaxAutomaticTokenAssociations(-1)
    .execute(hedera);
  const accountId = (await created.getReceipt(hedera)).accountId!.toString();

  if (env.PAY_ASSET === '0.0.0') {
    // HBAR fallback: fund the budget account with the same nominal value in tinybars.
    const fund = await new TransferTransaction()
      .addHbarTransfer(env.OPERATOR_ID, Hbar.fromTinybars((-BigInt(env.HUMAN_FUSD_FUND)).toString()))
      .addHbarTransfer(accountId, Hbar.fromTinybars(BigInt(env.HUMAN_FUSD_FUND).toString()))
      .execute(hedera);
    await fund.getReceipt(hedera);
  } else {
    const fund = await new TransferTransaction()
      .addTokenTransfer(env.PAY_ASSET, env.OPERATOR_ID, -BigInt(env.HUMAN_FUSD_FUND))
      .addTokenTransfer(env.PAY_ASSET, accountId, BigInt(env.HUMAN_FUSD_FUND))
      .execute(hedera);
    await fund.getReceipt(hedera);
  }

  const [row] = await sql<HumanRow[]>`
    insert into humans (human_hash, iss, sub, budget_account_id, budget_key_enc)
    values (${humanHash}, ${iss}, ${sub}, ${accountId}, ${encrypt(ecdsaKeyToHex(key))})
    on conflict (human_hash) do nothing
    returning *`;
  await sql`
    insert into policies (human_hash, cap_per_payment, daily_cap, allowlist)
    values (${humanHash}, ${env.POLICY_DEFAULT_CAP}, ${env.POLICY_DEFAULT_DAILY}, ${PROVIDER_IDS})
    on conflict (human_hash) do nothing`;
  return row ?? (await sql<HumanRow[]>`select * from humans where human_hash = ${humanHash}`)[0]!;
}

/** Publishes an APPROVAL record (no PII: humanHash + action digest only). */
export async function publishApproval(human: string, kind: 'LINK' | 'REVOKE' | 'OVERCAP', digest: string) {
  return publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'APPROVAL', human, kind, digest });
}
