import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
let sql: postgres.Sql;

// A throwaway human/agent to hang foreign keys off.
const HUMAN = 'test' + '0'.repeat(60);
const AGENT = '0x' + 'f'.repeat(40);

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 2, onnotice: () => {} });
  await sql`delete from intents where human_hash = ${HUMAN}`;
  await sql`delete from prov_jobs where job_key like 'testjob%'`;
  await sql`delete from fac_settlements where tx_id like '0.0.999@%'`;
  await sql`delete from agents where human_hash = ${HUMAN}`;
  await sql`delete from humans where human_hash = ${HUMAN}`;
  await sql`insert into humans (human_hash, iss, sub, budget_account_id, budget_key_enc)
            values (${HUMAN}, 'https://auth.world.org', 'sub_test', '0.0.1', 'enc')`;
});

afterAll(async () => {
  if (!url) return;
  await sql`delete from intents where human_hash = ${HUMAN}`;
  await sql`delete from prov_jobs where job_key like 'testjob%'`;
  await sql`delete from fac_settlements where tx_id like '0.0.999@%'`;
  await sql`delete from agents where human_hash = ${HUMAN}`;
  await sql`delete from humans where human_hash = ${HUMAN}`;
  await sql.end();
});

const insertIntent = (id: string, jobKey: string, round: number, txId: string) => sql`
  insert into intents (id, job_key, round, human_hash, agent_addr, provider_id, endpoint, pay_to, asset,
                       amount, tx_id, valid_start_ms, deadline_s, memo, payment_payload, requirements,
                       request_body, status)
  values (${id}, ${jobKey}, ${round}, ${HUMAN}, ${AGENT}, 'scribe-a', 'http://x', '0.0.2', '0.0.3',
          50000, ${txId}, 1, 2, 'm', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'CREATED')`;

d('schema: the constraints that enforce exactly-once (S4)', () => {
  it('intents: one intent per (job_key, round) — the second insert is rejected', async () => {
    const job = 'testjob' + 'a'.repeat(57);
    await insertIntent('i-a-r0', job, 0, '0.0.999@1700000001.000000000');
    await expect(insertIntent('i-a-r0-dup', job, 0, '0.0.999@1700000002.000000000')).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    );
    // a NEW round for the same job is allowed (that is what VOID opens)
    await expect(insertIntent('i-a-r1', job, 1, '0.0.999@1700000003.000000000')).resolves.toBeDefined();
  });

  it('intents: a tx id can never be reused across jobs', async () => {
    const tx = '0.0.999@1700000010.000000000';
    await insertIntent('i-b-r0', 'testjob' + 'b'.repeat(57), 0, tx);
    await expect(insertIntent('i-c-r0', 'testjob' + 'c'.repeat(57), 0, tx)).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    );
  });

  it('intents: status is constrained to the ICD-11 state machine', async () => {
    await expect(sql`
      insert into intents (id, job_key, round, human_hash, agent_addr, provider_id, endpoint, pay_to, asset,
                           amount, tx_id, valid_start_ms, deadline_s, memo, payment_payload, requirements,
                           request_body, status)
      values ('i-bad', 'testjob-bad', 0, ${HUMAN}, ${AGENT}, 's', 'e', '0.0.2', '0.0.3',
              1, '0.0.999@1700000099.000000000', 1, 2, 'm', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'MAYBE_PAID')
    `).rejects.toThrow(/violates check constraint/);
  });
});

const insertJob = (id: string, jobKey: string, txId: string, status: string) => sql`
  insert into prov_jobs (id, provider_id, job_key, round, agent_addr, payment_tx_id, amount, status,
                         audio_url, input_hash)
  values (${id}, 'scribe-a', ${jobKey}, 0, ${AGENT}, ${txId}, 50000, ${status}, 'http://a', 'sha256:x')`;

d('schema: the constraints that enforce run-at-most-once (S5)', () => {
  it('prov_jobs: a provider runs a given job key at most once', async () => {
    const job = 'testjob' + 'd'.repeat(57);
    await insertJob('p1', job, '0.0.999@1700000020.000000000', 'RUNNING');
    await expect(insertJob('p2', job, '0.0.999@1700000021.000000000', 'RUNNING')).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    );
    await expect(insertJob('p3', job, '0.0.999@1700000022.000000000', 'DONE')).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    );
  });

  it('prov_jobs: the partial index still allows a retry after a FAILED attempt', async () => {
    const job = 'testjob' + 'e'.repeat(57);
    await insertJob('p4', job, '0.0.999@1700000030.000000000', 'FAILED');
    await expect(insertJob('p5', job, '0.0.999@1700000031.000000000', 'RUNNING')).resolves.toBeDefined();
  });

  it('prov_jobs: one payment tx id can only ever buy one job', async () => {
    const tx = '0.0.999@1700000040.000000000';
    await insertJob('p6', 'testjob' + 'f'.repeat(57), tx, 'DONE');
    await expect(insertJob('p7', 'testjob' + '9'.repeat(57), tx, 'RUNNING')).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    );
  });
});

d('schema: facilitator replay table', () => {
  it('fac_settlements: tx_id is the primary key, so a replay collides', async () => {
    const tx = '0.0.999@1700000050.000000000';
    await sql`insert into fac_settlements (tx_id, status, pay_to, asset, amount)
              values (${tx}, 'SETTLING', '0.0.2', '0.0.3', 50000)`;
    await expect(sql`insert into fac_settlements (tx_id, status, pay_to, asset, amount)
              values (${tx}, 'SETTLING', '0.0.2', '0.0.3', 50000)`).rejects.toThrow(
      /duplicate key value violates unique constraint/,
    );
  });
});
