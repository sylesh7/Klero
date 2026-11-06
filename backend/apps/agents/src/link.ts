// Usage: pnpm --filter @forkos/agents link "<label>" [pairingCode]
// Creates (or reuses) an agent key in .secrets/agents.json, runs the World link flow, saves the token.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { agentIdentity, ForkosApi } from '@forkos/agent-kit';

const label = process.argv[2] ?? 'cli-agent';
const pairingCode = process.argv[3];
const FILE = join(process.cwd(), '..', '..', '.secrets', 'agents.json');
type Store = Record<string, { key: `0x${string}`; token?: string; accountId?: string }>;
const store: Store = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const key = store[label]?.key ?? generatePrivateKey();
const id = agentIdentity(key);

const api = new ForkosApi(process.env.FORKOS_API_URL ?? 'http://localhost:4040');
const start = await api.linkStart({ agentAddr: id.address, publicKeyHex: id.publicKeyHex, label, pairingCode });
console.log(`\nApprove on your phone (World ID):\n  ${start.verificationUriComplete ?? start.verificationUri}\n  code: ${start.userCode}\n`);
const linked = await api.linkWait(start.linkId);
store[label] = { key, token: linked.agentToken, accountId: linked.agent.accountId };
mkdirSync(join(FILE, '..'), { recursive: true });
writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
console.log('linked', { label, agent: id.address, accountId: linked.agent.accountId, epoch: linked.agent.epoch });
