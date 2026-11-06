#!/usr/bin/env -S npx tsx
import { Mirror } from '@forkos/shared';
import { Command } from 'commander';
import { audit } from './audit';

const program = new Command().name('forkos').description('Verify ForkOS agent payments from Hedera Mirror Node');

program
  .command('audit')
  .requiredOption('--topic <id>', 'ForkOS HCS topic id')
  .requiredOption('--operator <id>', 'ForkOS operator account (publisher of INTENT/SETTLED/VOID)')
  .option('--providers <ids>', 'comma-separated provider accounts (for REFUND)', '')
  .option('--job <jobKey>', 'only this job')
  .option('--mirror <url>', 'Mirror Node base URL', 'https://testnet.mirrornode.hedera.com')
  .action(async (o) => {
    const r = await audit({ topic: o.topic, operator: o.operator, providers: o.providers ? o.providers.split(',') : [], mirrorUrl: o.mirror, job: o.job });
    for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.job.slice(0, 16)}  ${c.check.padEnd(20)} ${c.detail}`);
    console.log(`\n${r.jobs} jobs, ${r.checks.length} checks — ${r.ok ? 'ALL PASSED' : 'VIOLATIONS FOUND'}`);
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('intent <txId> <deadline>')
  .description('Resolve one payment intent: PAID, FAILED, VOID or UNKNOWN')
  .action(async (txId: string, deadline: string) => {
    const { resolveIntent } = await import('@forkos/x402-hedera');
    console.log(await resolveIntent(new Mirror(), txId, Number(deadline)));
  });

await program.parseAsync();
