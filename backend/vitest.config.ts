import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Load .env for tests that talk to the local Postgres. Tests that need it skip when it is absent,
// so the suite still runs on a machine with no database.
const env: Record<string, string> = {};
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !m[2]!.startsWith('<')) env[m[1]!] = m[2]!;
  }
} catch {
  // no .env: database-backed tests skip themselves
}

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    env,
  },
});
