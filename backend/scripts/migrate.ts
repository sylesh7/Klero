import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');
// onnotice: silence the benign "relation already exists, skipping" NOTICE that
// `create table if not exists` emits on every re-run; it reads like a failure otherwise.
const sql = postgres(url, { max: 1, onnotice: () => {} });

await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
const dir = 'migrations';
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(file)) {
    console.log('skip', file);
    continue;
  }
  const text = readFileSync(join(dir, file), 'utf8');
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`insert into schema_migrations (name) values (${file})`;
  });
  console.log('applied', file);
}
await sql.end();
