import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDeployments, type Deployments } from '../src/deployments';

// loadDeployments caches module-wide, so this file exercises it exactly once from a fixture tree.
const fixture: Deployments = {
  network: 'hedera:testnet',
  createdAt: '2026-11-06T03:10:00.000Z',
  operatorId: '0.0.5001234',
  token: { id: '0.0.5001299', symbol: 'FUSD', decimals: 6 },
  topicId: '0.0.5001301',
  facilitatorFeePayerId: '0.0.5001300',
  providers: {
    'scribe-a': { accountId: '0.0.5001302', price: '50000', name: 'Scribe A' },
    'scribe-b': { accountId: '0.0.5001303', price: '40000', name: 'Scribe B' },
    'scribe-premium': { accountId: '0.0.5001304', price: '2000000', name: 'Scribe Premium' },
  },
  baselineAgents: ['0.0.5001305', '0.0.5001306', '0.0.5001307'],
};

let root = '';
let cwd = '';

beforeAll(() => {
  cwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'forkos-deploy-'));
  mkdirSync(join(root, 'deployments'), { recursive: true });
  writeFileSync(join(root, 'deployments', 'testnet.json'), JSON.stringify(fixture, null, 2));
  // services run from a nested package dir (e.g. services/api); the loader must walk up to find it
  const nested = join(root, 'services', 'api', 'src');
  mkdirSync(nested, { recursive: true });
  process.chdir(nested);
});

afterAll(() => process.chdir(cwd));

describe('loadDeployments', () => {
  it('walks up from a nested package dir and matches the ICD-4 shape', () => {
    const d = loadDeployments();
    expect(d.topicId).toBe('0.0.5001301');
    expect(d.token).toEqual({ id: '0.0.5001299', symbol: 'FUSD', decimals: 6 });
    expect(d.facilitatorFeePayerId).toBe('0.0.5001300');
    expect(Object.keys(d.providers)).toEqual(['scribe-a', 'scribe-b', 'scribe-premium']);
    expect(d.providers['scribe-a']!.price).toBe('50000');
    expect(d.baselineAgents).toHaveLength(3);
  });

  it('carries no private keys (the file is committed)', () => {
    const json = JSON.stringify(loadDeployments());
    expect(json).not.toMatch(/"key"/);
    expect(json).not.toMatch(/0x[0-9a-f]{64}/i);
  });

  it('caches, so repeat calls do not re-read the disk', () => {
    expect(loadDeployments()).toBe(loadDeployments());
  });
});
