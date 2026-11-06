export const NETWORK = 'hedera:testnet' as const;
export type HederaNetwork = typeof NETWORK;

export const CAPABILITY = 'transcribe+summarize.v1';

// Death clock (I.3). Do not change without updating the spec (P41) and the audit CLI.
export const VALID_START_BACKDATE_S = 5;
export const VALID_DURATION_S = 120;
export const RESEND_CUTOFF_S = 10;
export const VOID_MARGIN_S = 45;

// Coordination
export const CLAIM_WINDOW_S = 30; // must be even (Arkiv block time is 2 s)
export const WINNER_GRACE_S = 60; // a winner with no INTENT after this is abandoned (P32)
export const WINNER_HOLD_S = 600; // must be even: the winner extends its Arkiv claim this long so approvals can take minutes
export const APPROVAL_TTL_S = 300;
export const MIRROR_WAIT_TIMEOUT_MS = 30_000;

// URLs
export const DEFAULT_MIRROR_URL = 'https://testnet.mirrornode.hedera.com';
export const HASHSCAN_BASE = 'https://hashscan.io/testnet';
export const ARKIV_EXPLORER = 'https://rabdi.explorer.arkiv.network';

// Arkiv schema names (ICD-6)
export const SCHEMA_SERVICE = 'forkos.service.v1';
export const SCHEMA_AGENTLINK = 'forkos.agentlink.v1';
export const SCHEMA_CLAIM = 'forkos.claim.v1';

// HTTP headers (ICD-9)
export const H_JOB = 'x-forkos-job';
export const H_ROUND = 'x-forkos-round';
export const H_AGENT = 'x-forkos-agent';
export const H_CLAIM = 'x-forkos-claim';
