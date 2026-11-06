export const NETWORK = 'hedera:testnet' as const;
export type HederaNetwork = typeof NETWORK;

export const CAPABILITY = 'transcribe+summarize.v1';

// Death clock (I.3). Do not change without updating the spec (P41) and the audit CLI.
export const VALID_START_BACKDATE_S = 5;
export const VALID_DURATION_S = 120;
export const RESEND_CUTOFF_S = 10;
export const VOID_MARGIN_S = 45;

// Coordination
export const WINNER_GRACE_S = 60; // a winner with no INTENT after this is abandoned (P32)
export const APPROVAL_TTL_S = 300;
export const MIRROR_WAIT_TIMEOUT_MS = 30_000;

// URLs
export const DEFAULT_MIRROR_URL = 'https://testnet.mirrornode.hedera.com';
export const HASHSCAN_BASE = 'https://hashscan.io/testnet';

// HTTP headers (ICD-9)
export const H_JOB = 'x-forkos-job';
export const H_ROUND = 'x-forkos-round';
export const H_AGENT = 'x-forkos-agent';
