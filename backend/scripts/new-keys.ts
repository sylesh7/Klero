// Usage: pnpm keys:new            → prints an agent key + the API's random secrets
//        pnpm keys:new agent      → prints one agent key (FORKOS_AGENT_KEY)
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const mode = process.argv[2] ?? 'all';

function wallet(label: string) {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  console.log(`${label}=${key}    # address ${address}`);
}

if (mode === 'agent') {
  wallet('FORKOS_AGENT_KEY');
} else {
  wallet('FORKOS_AGENT_KEY');
  for (const name of ['SESSION_SECRET', 'KEY_ENCRYPTION_SECRET', 'HUMAN_SALT']) {
    console.log(`${name}=${randomBytes(32).toString('hex')}`);
  }
  console.log(`DEMO_KEY=${randomBytes(16).toString('hex')}`);
}
