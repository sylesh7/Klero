import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Deployments = {
  network: string;
  createdAt: string;
  operatorId: string;
  token: { id: string; symbol: string; decimals: number };
  topicId: string;
  facilitatorFeePayerId: string;
  providers: Record<string, { accountId: string; price: string; name: string }>;
  baselineAgents: string[];
};

let cached: Deployments | null = null;

/** Walks up from cwd until it finds deployments/testnet.json (pnpm runs scripts inside package dirs). */
export function loadDeployments(): Deployments {
  if (cached) return cached;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'deployments', 'testnet.json');
    if (existsSync(candidate)) {
      cached = JSON.parse(readFileSync(candidate, 'utf8')) as Deployments;
      return cached;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('deployments/testnet.json not found (run pnpm bootstrap:hedera and commit the file)');
}
