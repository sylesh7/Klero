import postgres from 'postgres';
import { env } from './config';

export const sql = postgres(env.DATABASE_URL, { max: 5, onnotice: () => {} });

export type JobRow = {
  id: string;
  provider_id: string;
  job_key: string;
  round: number;
  agent_addr: string;
  payment_tx_id: string;
  payer_account: string | null;
  amount: string;
  status: 'PAYING' | 'RUNNING' | 'DONE' | 'FAILED' | 'REFUNDED' | 'PAYMENT_FAILED';
  audio_url: string;
  input_hash: string;
  transcript: string | null;
  summary: string | null;
  output_hash: string | null;
  refund_tx_id: string | null;
  error: string | null;
  agentkit_human: string | null; // World AgentBook anonymous human id (migration 002)
  agentkit_address: string | null;
  created_at: Date;
  updated_at: Date;
};
