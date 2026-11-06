import postgres from 'postgres';
import { env } from './config';

export const sql = postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} });

export type HumanRow = {
  human_hash: string;
  iss: string;
  sub: string;
  budget_account_id: string;
  budget_key_enc: string;
  created_at: Date;
};

export type AgentRow = {
  agent_addr: string;
  human_hash: string;
  label: string;
  account_id: string;
  public_key_hex: string;
  epoch: number;
  status: 'ACTIVE' | 'REVOKED';
  link_seq: string | null;
  linked_at: Date;
  revoked_at: Date | null;
};

export type AttemptRow = {
  id: string;
  kind: 'LOGIN' | 'LINK' | 'REVOKE' | 'OVERCAP';
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'FAILED';
  device_code_enc: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string | null;
  interval_s: number;
  expires_at: Date;
  started_at: Date;
  next_poll_at: Date;
  expected_sub: string | null;
  human_hash: string | null;
  context: Record<string, unknown>;
  result_iss: string | null;
  result_sub: string | null;
  auth_time: string | null;
  acr: string | null;
  amr: unknown;
  reason: string | null;
};

export type ApprovalRow = {
  id: string;
  human_hash: string;
  kind: 'REVOKE' | 'OVERCAP';
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'USED';
  action: Record<string, unknown>;
  digest: string;
  world_attempt_id: string | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

export type IntentRow = {
  id: string;
  job_key: string;
  round: number;
  human_hash: string;
  agent_addr: string;
  provider_id: string;
  endpoint: string;
  pay_to: string;
  asset: string;
  amount: string;
  tx_id: string;
  valid_start_ms: string;
  deadline_s: string;
  memo: string;
  payment_payload: Record<string, unknown>;
  requirements: Record<string, unknown>;
  request_body: { audioUrl: string; inputHash: string };
  status: 'CREATED' | 'SENT' | 'PAYMENT_UNKNOWN' | 'PAID' | 'DONE' | 'REFUNDED' | 'REJECTED' | 'FAILED' | 'VOID';
  approval_id: string | null;
  attempts: number;
  last_error: string | null;
  settle_response: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  consensus_ts: string | null;
  agentkit_header: string | null; // World AgentKit header signed by the agent (migration 002)
  created_at: Date;
  updated_at: Date;
};
