-- ForkOS schema v1. Money is stored in smallest units (bigint). Timestamps are timestamptz.

-- ───────── facilitator ─────────
create table if not exists fac_settlements (
  tx_id        text primary key,               -- SDK format 0.0.X@S.N
  status       text not null check (status in ('SETTLING','SETTLED','FAILED')),
  attempts     int  not null default 1,
  pay_to       text not null,
  asset        text not null,
  amount       bigint not null,
  last_error   text,
  settle_tx    text,                           -- transaction id returned by settle (same as tx_id)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ───────── provider ─────────
create table if not exists prov_jobs (
  id             text primary key,             -- providerId + ':' + payment tx id
  provider_id    text not null,
  job_key        text not null,
  round          int  not null,
  agent_addr     text not null,
  payment_tx_id  text not null unique,
  payer_account  text,
  amount         bigint not null,
  status         text not null check (status in ('PAYING','RUNNING','DONE','FAILED','REFUNDED','PAYMENT_FAILED')),
  audio_url      text not null,
  input_hash     text not null,
  transcript     text,
  summary        text,
  output_hash    text,
  refund_tx_id   text,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- A provider executes a given job at most once (S5).
create unique index if not exists prov_jobs_one_exec
  on prov_jobs (provider_id, job_key) where status in ('RUNNING','DONE');

-- ───────── api ─────────
create table if not exists humans (
  human_hash         text primary key,
  iss                text not null,
  sub                text not null,
  budget_account_id  text not null,
  budget_key_enc     text not null,          -- AES-256-GCM (KEY_ENCRYPTION_SECRET)
  created_at         timestamptz not null default now(),
  unique (iss, sub)
);

create table if not exists owner_sessions (
  token_hash   text primary key,
  human_hash   text not null references humans(human_hash),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

create table if not exists world_attempts (
  id                         text primary key,
  kind                       text not null check (kind in ('LOGIN','LINK','REVOKE','OVERCAP')),
  status                     text not null check (status in ('PENDING','APPROVED','DENIED','EXPIRED','FAILED')),
  device_code_enc            text not null,
  user_code                  text not null,
  verification_uri           text not null,
  verification_uri_complete  text,
  interval_s                 int  not null,
  expires_at                 timestamptz not null,
  started_at                 timestamptz not null default now(),
  next_poll_at               timestamptz not null default now(),
  expected_sub               text,            -- pinned for REVOKE/OVERCAP when sub is stable
  human_hash                 text,            -- owner who started it (REVOKE/OVERCAP/LINK-with-pairing)
  context                    jsonb not null default '{}'::jsonb,
  result_iss                 text,
  result_sub                 text,
  auth_time                  bigint,
  acr                        text,
  amr                        jsonb,
  reason                     text,
  updated_at                 timestamptz not null default now()
);
create index if not exists world_attempts_pending on world_attempts (status, next_poll_at);

create table if not exists pairings (
  code        text primary key,
  human_hash  text not null references humans(human_hash),
  label       text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create table if not exists agents (
  agent_addr      text primary key,
  human_hash      text not null references humans(human_hash),
  label           text not null,
  account_id      text not null,
  public_key_hex  text not null,
  epoch           int  not null,
  status          text not null check (status in ('ACTIVE','REVOKED')),
  arkiv_key       text,
  link_seq        bigint,
  linked_at       timestamptz not null default now(),
  revoked_at      timestamptz
);

create table if not exists agent_tokens (
  token_hash  text primary key,
  agent_addr  text not null references agents(agent_addr),
  epoch       int  not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table if not exists policies (
  human_hash       text primary key references humans(human_hash),
  cap_per_payment  bigint not null,
  daily_cap        bigint not null,
  allowlist        text[] not null,
  updated_at       timestamptz not null default now()
);

create table if not exists approvals (
  id                text primary key,
  human_hash        text not null references humans(human_hash),
  kind              text not null check (kind in ('REVOKE','OVERCAP')),
  status            text not null check (status in ('PENDING','APPROVED','DENIED','EXPIRED','USED')),
  action            jsonb not null,
  digest            text not null,
  world_attempt_id  text references world_attempts(id),
  expires_at        timestamptz not null,
  used_at           timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists intents (
  id               text primary key,           -- jobShort-rN
  job_key          text not null,
  round            int  not null,
  human_hash       text not null,
  agent_addr       text not null,
  provider_id      text not null,
  endpoint         text not null,
  pay_to           text not null,
  asset            text not null,
  amount           bigint not null,
  tx_id            text not null unique,
  valid_start_ms   bigint not null,
  deadline_s       bigint not null,
  memo             text not null,
  payment_payload  jsonb not null,             -- the exact x402 PaymentPayload (same bytes on every resend)
  requirements     jsonb not null,
  request_body     jsonb not null,
  status           text not null check (status in
                    ('CREATED','SENT','PAYMENT_UNKNOWN','PAID','DONE','REFUNDED','REJECTED','FAILED','VOID')),
  approval_id      text references approvals(id),
  attempts         int  not null default 0,
  last_error       text,
  settle_response  jsonb,
  result           jsonb,
  consensus_ts     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (job_key, round)
);
create index if not exists intents_unknown on intents (status) where status in ('SENT','PAYMENT_UNKNOWN','REJECTED');

create table if not exists events (
  id          bigserial primary key,
  name        text not null,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);
