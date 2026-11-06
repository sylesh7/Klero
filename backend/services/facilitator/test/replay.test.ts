import { Client, TransferTransaction } from '@hiero-ledger/sdk';
import { txIdWithValidStart } from '@forkos/shared';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
const hasEnv = Boolean(url && process.env.FACILITATOR_FEE_PAYER_ID && process.env.FACILITATOR_FEE_PAYER_KEY);
const d = hasEnv ? describe : describe.skip;

const sql = url ? postgres(url, { max: 2, onnotice: () => {} }) : (null as unknown as postgres.Sql);
const PAYER = '0.0.90901';

/** A freshly-signed, in-window intent for a unique tx id. */
function freshPayload(validStartMs = Date.now() - 5_000) {
  const tx = new TransferTransaction()
    .addHbarTransfer('0.0.1001', -5)
    .addHbarTransfer('0.0.1002', 5)
    .setTransactionId(txIdWithValidStart(PAYER, validStartMs))
    .setTransactionValidDuration(120)
    .setTransactionMemo('forkos:0123456789abcdef:r0');
  const client = Client.forTestnet();
  tx.freezeWith(client);
  client.close();
  return {
    txId: tx.transactionId!.toString(),
    payload: { x402Version: 2, accepted: {} as never, payload: { transaction: Buffer.from(tx.toBytes()).toString('base64') } },
  };
}

const requirements = {
  scheme: 'exact',
  network: 'hedera:testnet',
  asset: '0.0.11332887',
  amount: '50000',
  payTo: '0.0.11332881',
  maxTimeoutSeconds: 60,
  extra: {},
} as never;

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

afterAll(async () => {
  if (!url) return;
  await sql`delete from fac_settlements where pay_to = '0.0.11332881' and tx_id like ${`${PAYER}@%`}`;
  await sql.end();
});

beforeEach(async () => {
  if (!url) return;
  await sql`delete from fac_settlements where tx_id like ${`${PAYER}@%`}`;
});

d('facilitator replay table (S4 at our door)', () => {
  it('rejects a settle for a tx id already SETTLING, without touching the network', async () => {
    const { settleOnce } = await import('../src/settle');
    const { txId, payload } = freshPayload();
    await sql`insert into fac_settlements (tx_id, status, pay_to, asset, amount)
              values (${txId}, 'SETTLING', '0.0.11332881', '0.0.11332887', 50000)`;

    const res = await settleOnce(payload, requirements, log);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe('forkos_replay_detected');
    expect(res.errorMessage).toMatch(/already SETTLING/);

    // attempts must NOT have been bumped: the row was never re-claimed
    const [row] = await sql<{ attempts: number }[]>`select attempts from fac_settlements where tx_id = ${txId}`;
    expect(row!.attempts).toBe(1);
  });

  it('rejects a settle for a tx id already SETTLED (the money already moved)', async () => {
    const { settleOnce } = await import('../src/settle');
    const { txId, payload } = freshPayload();
    await sql`insert into fac_settlements (tx_id, status, pay_to, asset, amount)
              values (${txId}, 'SETTLED', '0.0.11332881', '0.0.11332887', 50000)`;

    const res = await settleOnce(payload, requirements, log);
    expect(res.errorReason).toBe('forkos_replay_detected');
    expect(res.errorMessage).toMatch(/already SETTLED/);
  });

  it('refuses an expired intent before it ever reaches the replay table', async () => {
    const { settleOnce } = await import('../src/settle');
    const { txId, payload } = freshPayload(Date.now() - 119_000); // 1 s of life left
    const res = await settleOnce(payload, requirements, log);
    expect(res.errorReason).toBe('forkos_intent_expired');
    const rows = await sql`select 1 from fac_settlements where tx_id = ${txId}`;
    expect(rows).toHaveLength(0); // never claimed, so a later legitimate attempt is not blocked
  });

  it('refuses an undecodable payload', async () => {
    const { settleOnce } = await import('../src/settle');
    const res = await settleOnce(
      { x402Version: 2, accepted: {} as never, payload: { transaction: 'AA==' } },
      requirements,
      log,
    );
    expect(res.errorReason).toBe('forkos_undecodable_transaction');
  });

  it('a FAILED attempt may be retried and bumps attempts (network dedupe still protects)', async () => {
    const { txId } = freshPayload();
    await sql`insert into fac_settlements (tx_id, status, pay_to, asset, amount)
              values (${txId}, 'FAILED', '0.0.11332881', '0.0.11332887', 50000)`;
    // the exact claim query settleOnce runs
    const claimed = await sql<{ attempts: number }[]>`
      insert into fac_settlements (tx_id, status, pay_to, asset, amount)
      values (${txId}, 'SETTLING', '0.0.11332881', '0.0.11332887', 50000)
      on conflict (tx_id) do update
        set status = 'SETTLING', attempts = fac_settlements.attempts + 1, updated_at = now()
        where fac_settlements.status = 'FAILED'
      returning status, attempts`;
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.attempts).toBe(2);
  });

  it('two concurrent settles for one tx id: exactly one claims it', async () => {
    const { txId } = freshPayload();
    const claim = () => sql`
      insert into fac_settlements (tx_id, status, pay_to, asset, amount)
      values (${txId}, 'SETTLING', '0.0.11332881', '0.0.11332887', 50000)
      on conflict (tx_id) do update
        set status = 'SETTLING', attempts = fac_settlements.attempts + 1, updated_at = now()
        where fac_settlements.status = 'FAILED'
      returning status`;
    const results = await Promise.allSettled([claim(), claim()]);
    const winners = results.filter((r) => r.status === 'fulfilled' && (r.value as unknown[]).length === 1);
    expect(winners).toHaveLength(1); // the other got 0 rows or a serialization error — never two settlements
  });
});
