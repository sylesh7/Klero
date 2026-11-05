# ForkOS — Master Backend Build Doc

> **Agents fork. Money doesn't.**
> ETHGlobal Mumbai 2026 · the exactly-once layer for AI agent payments · build doc for the **backend**.
> Companion doc: **Frontend** (written next). The frontend only talks to the API defined in §ICD-7 and §ICD-8 of this doc.

| | |
|---|---|
| Owner | Backend (everything except `apps/web`) |
| You hand off to Frontend | **H1** (local API + SSE running, Sat 00:00 IST), **H2** (deployed API URL, Sat 03:00 IST) |
| Submission deadline | **Sat 7 Nov 2026, 09:00 IST** (ETHGlobal form closes; no late submissions) |
| Feature freeze | **Sat 7 Nov, 04:00 IST** — after this only bug fixes, README, video |
| Networks | Hedera **testnet** (`hedera:testnet`), Arkiv **Rabdi** testnet (chain id `7794095`), World ID (issuer from env) |
| Stack | Node ≥ 22.10, pnpm 9, TypeScript 5.9, tsx, Fastify 5, postgres.js 3.4, zod 3, `@hiero-ledger/sdk` 2.90.1, `@x402/*` 2.30.0, `@arkiv-network/sdk` 1.0.1, viem 2, `@modelcontextprotocol/sdk` 1.32, `jose` 6, `openai` 7, Railway |

---

## Table of contents

- [Part I — Context you must read once](#part-i--context-you-must-read-once)
  - [I.1 What we are building (60-second version)](#i1-what-we-are-building-60-second-version)
  - [I.2 The six safeguards and who enforces each](#i2-the-six-safeguards-and-who-enforces-each)
  - [I.3 The death clock — the core idea, precisely](#i3-the-death-clock--the-core-idea-precisely)
  - [I.4 One job, end to end](#i4-one-job-end-to-end)
  - [I.5 Sponsor requirements → where this doc satisfies them](#i5-sponsor-requirements--where-this-doc-satisfies-them)
  - [I.6 Hackathon rules that affect your code](#i6-hackathon-rules-that-affect-your-code)
  - [I.7 Verified facts (and how we verified them)](#i7-verified-facts-and-how-we-verified-them)
  - [I.8 Things verified at runtime in Phase 0–5 (and their fallbacks)](#i8-things-verified-at-runtime-in-phase-05-and-their-fallbacks)
  - [I.9 Schedule](#i9-schedule)
- [Part II — Interface Control Document (ICD)](#part-ii--interface-control-document-icd)
- [Part III — Build phases P0 → P46](#part-iii--build-phases)
- [Part IV — Threat model → test mapping](#part-iv--threat-model--test-mapping)
- [Part V — Troubleshooting](#part-v--troubleshooting)
- [Part VI — Final checklist](#part-vi--final-checklist)

---

## Part I — Context you must read once

### I.1 What we are building (60-second version)

AI agents now pay for things on their own over **x402** (HTTP `402 Payment Required` → sign → retry). Every
agent wallet built so far stops *bad* payments (limits, allowlists, scam checks). None of them answer the
question every agent hits eventually: **"I sent a payment, the connection dropped. Did I pay?"** Agents
either retry and pay twice, or give up and never deliver. Parallel sub-agents on different platforms make it
worse: your Claude agent and your Cursor agent can both buy the same transcription.

**ForkOS is the exactly-once layer for agent payments.**

1. Every agent **links to its human once** with **World ID Agent Pass** (fresh authentication on a phone).
   The human gets a stable private id → `humanHash`. All of that human's agents share one budget and one
   dedupe scope.
2. Agents **discover paid services** from a public directory on **Arkiv**.
3. An agent that wants to buy something **posts a claim**: an **Arkiv** entity owned by the agent's own
   wallet (expires automatically) **and** a message on a **Hedera Consensus Service** topic.
4. **HCS consensus order is the referee:** the first valid claim for a job round wins. Every agent, the
   provider and the auditor compute the same winner from public data — no trust in our server.
5. The winner's payment is built by ForkOS as a **payment intent**: a Hedera transfer whose
   **transaction id is known before it is sent** and which **dies 120 seconds after its valid start**.
   It is stored *before* it leaves the machine. Retries resend **the same bytes**, never re-sign.
6. It settles through **Hedera x402** via **our own facilitator** (with a replay table), in an
   **HTS token** (`FUSD`).
7. If the outcome is unknown (dropped connection, killed process), the **resolver** asks **Mirror Node**:
   found → **PAID**; not found after the death clock + margin → **provably VOID forever** → the next round
   opens. There is no third state and no guessing.
8. The **provider** checks **Arkiv** before it runs a job (is this the live winner? is the agent's
   authority current?), settles, then runs the job. If it fails after payment it **refunds in HTS**.
9. **Firing/replacing an agent** and **spending above the autonomous cap** require a fresh **World ID**
   approval bound to that one action.
10. Everything is written to **HCS**; `npx forkos audit` rebuilds and verifies the whole history from
    **Mirror Node**.

It ships as: an **x402 extension spec** (payment intents for Hedera `exact`), the **`@forkos/x402-hedera`**
npm wrapper, an **MCP server** (`forkos-mcp`) that gives any MCP agent a safe `pay` tool, the **`forkos` CLI**,
three live **paid services**, our **facilitator**, and the **API** the dashboard uses.

The demo: two agents on different platforms get the same job → one payment. Then judges try to make us pay
twice (kill the payer mid-flight, replay old payments, revive a fired agent) while a payment counter **read
from Mirror Node, not our database** stays at **1**.

### I.2 The six safeguards and who enforces each

| # | Safeguard | Enforced by | Where in code |
|---|---|---|---|
| S1 | Only a linked agent of *this* human can act for them | **World ID** (device flow) + Arkiv `AgentLink` + HCS `LINK` | `services/api/src/routes/agents.ts`, P25 |
| S2 | One winner per job round, decided publicly | **HCS** consensus order + `referee.ts` | `packages/shared/src/referee.ts`, P9 |
| S3 | Agents never hold payment keys; the payer only signs for the HCS winner, within policy | API payer + Postgres row lock | `services/api/src/payer.ts`, P30 |
| S4 | A payment can settle **at most once, ever**, and unknown outcomes resolve to PAID or provably VOID | **Hedera** (tx-id dedupe + expiry) + **Mirror Node** + facilitator replay table | `packages/x402-hedera`, `services/facilitator`, P11–P15, P32 |
| S5 | A provider runs a job only for the live winner with current authority, and only after settlement | Provider fence reading **Arkiv** + HCS | `services/provider/src/fence.ts`, P19 |
| S6 | Fire/replace and over-cap spending need a fresh human approval bound to the exact action | **World ID** step-up | `services/api/src/routes/approvals.ts`, P26, P31 |

Remove any sponsor and a specific safeguard disappears. That is the "why do you use X" answer for judges.

### I.3 The death clock — the core idea, precisely

Verified facts (see I.7):

- In Hedera's x402 `exact` scheme the **client** builds the `TransferTransaction`, sets
  `transactionId.accountId = extra.feePayer`, signs, and sends base64 bytes. The facilitator adds its
  fee-payer signature and submits. → **We choose the transaction id ourselves**, so we know it before sending.
- The network rejects a transaction id it has seen in the last **180 seconds** (`DUPLICATE_TRANSACTION`).
- The network rejects a transaction whose `validStart + validDuration` is before consensus time
  (`TRANSACTION_EXPIRED`). The SDK default `validDuration` is **120 s**; we set it explicitly.

Our constants (`packages/shared/src/constants.ts`):

| Constant | Value | Meaning |
|---|---|---|
| `VALID_START_BACKDATE_S` | 5 | `validStart = now − 5 s` (avoids `INVALID_TRANSACTION_START` from clock skew) |
| `VALID_DURATION_S` | 120 | the transaction is dead after `validStart + 120 s` |
| `RESEND_CUTOFF_S` | 10 | never resend bytes with < 10 s left |
| `VOID_MARGIN_S` | 45 | wait this long after the deadline before trusting a Mirror Node 404 |

The rule the whole product rests on:

```text
deadline = validStart + 120 s

state(intent) =
  PAID   if Mirror Node has the tx id with result SUCCESS            (any time)
  FAILED if Mirror Node has the tx id with a non-SUCCESS result      (money did not move)
  VOID   if now > deadline + 45 s  AND  Mirror Node returns 404       (can never execute again)
  UNKNOWN otherwise                                                   (wait; never re-sign)
```

Why VOID is a *proof*, not a guess: after `deadline` every node rejects those bytes as expired, and any
copy submitted before the deadline would have reached consensus and appear on Mirror Node within a few
seconds. 45 s of margin covers Mirror Node ingestion. So a 404 after `deadline + 45 s` means the payment
did not happen and **cannot** happen — not even if a malicious facilitator still holds the signed bytes.

### I.4 One job, end to end

```text
Agent A (Claude, MCP)          Agent B (script, OpenAI)        ForkOS API (payer)           Provider "Scribe-A"        Hedera / Arkiv
───────────────────────        ────────────────────────        ──────────────────           ──────────────────         ──────────────
discover services ─────────────────────────────────────────────────────────────────────────────────────────────────▶ Arkiv: Service entities
jobKey = H(human, cap, inputHash)   jobKey (same)
post Claim ───────────────────────────────────────────────────────────────────────────────────────────────────────▶ Arkiv Claim (owner=A)
submit CLAIM ─────────────────────────────────────────────────────────────────────────────────────────────────────▶ HCS seq 41
                                post Claim / CLAIM ───────────────────────────────────────────────────────────────▶ Arkiv + HCS seq 42
read topic via Mirror → winner = seq 41 (A)    reads → winner = A → backs off (claim expires in 30 s)
POST /v1/pay ────────────────▶  check: A is HCS winner, linked, epoch current; policy OK (≤ cap)
                                build intent: txId 0.0.F@T.N, validStart T, 120 s, memo forkos:<job>:r0
                                INSERT intents (unique job,round)  ← stored BEFORE sending
                                HCS INTENT ──────────────────────────────────────────────────────────────────────▶ HCS
                                POST /v1/jobs + PAYMENT-SIGNATURE ─▶ fence: Arkiv claim + link + referee ✓
                                                                   facilitator /verify ✓ (+ replay table)
                                                                   facilitator /settle ──────────────────────────▶ Hedera transfer FUSD
                                                                   run job (Whisper + summary)
                                ◀──────────────────────────────── 200 {transcript, summary} + PAYMENT-RESPONSE
                                HCS SETTLED, DONE ─────────────────────────────────────────────────────────────▶ HCS
patch Claim → PAID ───────────────────────────────────────────────────────────────────────────────────────────────▶ Arkiv
```

If the arrow from the provider back to the API is lost: intent → `PAYMENT_UNKNOWN` → resolver → Mirror Node
→ PAID (fetch result by tx id from the provider) or, after the clock, VOID → HCS `VOID` → round 1 opens.

### I.5 Sponsor requirements → where this doc satisfies them

**Hedera — AI Agents That Pay: x402 ($6,500)**

| Requirement (verbatim intent) | Satisfied by |
|---|---|
| ≥1 x402-protected endpoint settling on Hedera testnet via a listed facilitator **or one you run yourself** | `services/provider` `POST /v1/jobs` (P17–P21) settling through `services/facilitator` (P11–P13) |
| An agent/client that **finds** the endpoint and completes ≥1 paid request end to end, **no human approving** | agents discover via Arkiv `Service` (P16, P36); under-cap payments run with zero human steps (P30) |
| Public repo, README with setup, architecture, payment flow, **Hedera tx id of ≥1 settled payment** | P44 README phase (tx table with HashScan links) |
| Demo video ≤ 5 min showing a payment settle with a HashScan link | P45 runbook (ETHGlobal requires 2–4 min, which satisfies both) |
| Extra: spending controls (budgets, per-merchant limits, allowlists, human approval above an amount) | P28 policy + P31 World over-cap approval |
| Extra: HCS topic as tamper-evident audit log of each agent's spending | P6 topic, every event published (P8), `forkos audit` (P40) |
| Extra: multi-agent negotiation before payment | claim → HCS order → one winner (P9, P29) |
| Extra: settling in an HTS token | `FUSD` HTS token, own facilitator (P6, P12) |
| Extra: Hedera Network MCP / Agent Kit | not used (we ship our own MCP server; optional) |

**Hedera — No Solidity Allowed ($2,000)** — same partner slot

| Requirement | Satisfied by |
|---|---|
| JS/TS SDK, **no Solidity** | the repo has zero `.sol` files; all Hedera work via `@hiero-ledger/sdk` |
| ≥ 2 native services | **HCS** (referee + audit log) and **HTS** (payment token + refunds) |
| Repo + README + video ≤ 5 min | P44, P45 |
| Extras: Mirror Node, creative HCS, security | resolver/audit (Mirror Node), HCS as the referee, agents hold no payment keys |

**World — World ID Agent Pass ($5,000, new projects)**

| Requirement | Satisfied by |
|---|---|
| Official Agent Pass | OIDC device flow against the issuer in `WORLD_ISSUER` (P24) |
| Complete journey: request → user completion → validated result → protected action | three protected actions: **link agent** (P25), **fire/replace agent** (P26), **over-cap payment** (P31) |
| Denied/expired/cancelled path where the action does not occur | cancel (`access_denied`), expire (`expired_token`), wrong human (`access_denied` via pinned `sub`), replayed/mismatched approval (our digest check) — P27 tests |
| Validate in a secure backend; no client secrets exposed | secret only in API env; ID token verified with `jose` against JWKS (`iss`, `aud`, `exp`, `auth_time`) + DB row lock (P24) |
| Integration debrief | `docs/world-debrief.md` (P44) |

**Arkiv — Build on Arkiv, from scratch ($4,000)**

| Requirement | Satisfied by |
|---|---|
| Writes to current testnet with `@arkiv-network/sdk` | Rabdi, P10 |
| ≥1 user-visible feature **reads** from Arkiv | service directory (agents + dashboard), claim board (dashboard), provider fence (P10, P16, P19, P34) |
| README: writer wallet address(es) + one runnable query | P44 |
| `/arkiv/schema.md`, `/arkiv/friction.md`, one file per criterion | P43 |
| Open-source licence + AI disclosure | P1 `LICENSE`, P44 |

### I.6 Hackathon rules that affect your code

- **Classic "from scratch":** all project code is written after hacking starts. Public libraries are fine.
  This doc and the earlier README are planning artifacts: **commit them in `docs/planning/`** and disclose
  them (ETHGlobal requires spec/planning files when using spec-driven development).
- **Commit history is judged.** Commit and push after every phase with the exact message given. No giant
  final commits.
- **AI attribution** in README: which files/parts were AI-assisted.
- **Video:** 2–4 min, ≥ 720p, no AI voiceover, not sped up, no music-only narration.
- **Partner prizes:** pick exactly **Hedera** (both tracks count as one), **World**, **Arkiv**.

### I.7 Verified facts (and how we verified them)

Every API below was checked against the **installed npm package source/types** or the **official docs**
before this doc was written. If something disagrees with reality, the exit check in that phase catches it.

| Fact | Source |
|---|---|
| `@x402/hedera@2.30.0` exports `./exact/client`, `./exact/server`, `./exact/facilitator`; depends on `@hiero-ledger/sdk@2.90.1` | package.json |
| Client signer interface: `{ accountId; createPartiallySignedTransferTransaction(requirements): Promise<base64> }` | `signer-*.d.mts` |
| Default signer uses `TransactionId.generate(feePayer)` + `freezeWith(client)` + `sign(key)` → `toBytes()` | `dist/esm/index.mjs` |
| Facilitator signer = `{ getAddresses, signAndSubmitTransaction, verifyPayerSignature, preflightTransfer, resolveAccount? }`; helpers `createHederaSignAndSubmitTransaction`, `createHederaVerifyPayerSignature`, `createHederaPreflightTransfer`, `toFacilitatorHederaSigner` | same |
| Reference facilitator verify **does not** track replays; it relies on network dedupe | `exact/facilitator/index.mjs` |
| Facilitator invalid reasons include `invalid_exact_hedera_payload_signature_invalid`, `…_preflight_failed`, `…_fee_payer_mismatch`, `accepted_payment_requirements_mismatch`, `fee_payer_not_managed_by_facilitator` | same |
| `@x402/core` exports `x402Facilitator` (`./facilitator`), `x402ResourceServer` + `HTTPFacilitatorClient` (`./server`), `x402Client` + `x402HTTPClient` (`./client`), header codecs (`./http`) | `dist/esm/*.d.mts` |
| `HTTPFacilitatorClient` calls `${url}/verify`, `${url}/settle` with body `{x402Version, paymentPayload, paymentRequirements}`, `GET ${url}/supported`; a 200 with `{isValid:false}` is a normal result | `chunk-U5TAZTKB.mjs` |
| HTTP headers: request `PAYMENT-SIGNATURE` (legacy `X-PAYMENT`), 402 response `PAYMENT-REQUIRED`, success `PAYMENT-RESPONSE` | same |
| `@x402/fastify` `paymentMiddleware` runs the route handler **before** settlement (onRequest verify, onSend settle) → **unsafe for paid jobs**; we use `x402ResourceServer` directly | `@x402/fastify/dist/esm/index.mjs` |
| `Price = Money \| {asset, amount, extra?}` → we pass explicit `{asset, amount}` | core types |
| SDK: `TransactionId.withValidStart(AccountId, Timestamp)`, `Timestamp(seconds, nanos)`, `Transaction.setTransactionValidDuration(n)`, `setTransactionMemo`, `freezeWith`, `sign`, `toBytes`, `Transaction.fromBytes`, getters `transactionId`, `transactionValidDuration` | `@hiero-ledger/sdk` d.ts |
| SDK `TransactionId.toString()` = `0.0.X@SECONDS.NNNNNNNNN` (9-digit zero-padded nanos) | `TransactionId.cjs` |
| Mirror Node tx id format = `0.0.X-SECONDS-NNNNNNNNN`; unknown id → HTTP 404 | live testnet mirror |
| Mirror topic message fields: `consensus_timestamp, message (base64), payer_account_id, running_hash, running_hash_version, sequence_number, topic_id, chunk_info` | live testnet mirror |
| `AccountCreateTransaction.setECDSAKeyWithAlias`, `setInitialBalance`, `setMaxAutomaticTokenAssociations`; `TransactionReceipt.topicSequenceNumber`; `PublicKey.toEvmAddress()` | SDK d.ts |
| Testnet USDC is `0.0.429274` (we use our own `FUSD` token instead; USDC is an env switch) | `@x402/hedera` constants |
| Hedera portal creates an **ECDSA** testnet account funded with **1000 HBAR**; DER private key starts with `303`; faucet gives 100 HBAR per request | docs.hedera.com |
| Arkiv SDK 1.0.1: `createPublicClient/createWalletClient`, chain `rabdi({accessKey})` (id 7794095), `defineSchema`, column types `str u64 addr key bool i32 dec bytes`, `.indexed()`, `createEntity(schema, values, {expiration})`, `patchEntity(schema, key, {set})`, `extendEntity({entityKey, expiration})`, `deleteEntity({entityKey})`, query builder `select().from().where().ownedBy().orderBy().limit().fetch()`, `ExpirationTime.fromSeconds/atDate`, **block time 2 s**, `str` ≤ 128 bytes, page ≤ 100 rows | SDK README + d.ts |
| World: issuer `https://auth.world.org` (sandbox `https://sandbox.auth.world.org`), endpoints `/api/v1/device_authorization`, `/api/v1/token`, discovery `/.well-known/openid-configuration`; scope `openid` only; device flow requires a **confidential** client, **always forces fresh auth**, ID token has `auth_time, acr, amr` and **no `nonce`**; device code lives **20 min**; poll errors `authorization_pending, slow_down (+5 s), access_denied, expired_token`; `claims={"id_token":{"sub":{"value":"…"}}}` makes a different account end in `access_denied`; `sub` is pairwise per sector and stable for the same account | auth.world.org/docs (oidc, step-up, id-token, testing) |
| OpenAI SDK 7.52: `audio.transcriptions.create({file, model:'whisper-1'})`, `audio.speech.create({model:'gpt-4o-mini-tts', voice:'alloy', input})`, `toFile` | `openai` d.ts |
| MCP SDK 1.32: `McpServer.registerTool(name, {title, description, inputSchema}, cb)`, `StdioServerTransport` | `@modelcontextprotocol/sdk` d.ts |

### I.8 Things verified at runtime in Phase 0–5 (and their fallbacks)

| Thing | Checked in | If it fails |
|---|---|---|
| A client-built intent with our own tx id + 120 s duration settles through our facilitator in `FUSD` | P15 exit checks | Set `PAY_ASSET=HBAR` (`0.0.0`); HTS stays for refunds, No-Solidity still qualifies |
| World ID issuer used at Mumbai (production with mocked proofs vs sandbox) | P4 | Change `WORLD_ISSUER`; nothing else changes |
| Same World test identity returns the **same `sub`** on two sign-ins | P4 + P24 exit checks | `WORLD_SUB_STABLE=false` → agents link through a pairing code created in the owner's dashboard (P25 handles both) |
| Arkiv claim with ~30 s lifetime disappears on time | P10 | Raise `CLAIM_WINDOW_S` (must be even); the referee never depends on Arkiv expiry for correctness |
| Mirror Node lag for HCS messages | P8 | Raise `MIRROR_WAIT_TIMEOUT_MS` |

### I.9 Schedule

Times are IST. Today is **Fri 6 Nov**. If you are behind, protect the order: P0–P15 (money moves) →
P17–P21 (paid service) → P29–P33 (payer + resolver) → P23–P27 (World) → P34 (Arkiv on dashboard) →
everything else.

| Block | Phases | Target done |
|---|---|---|
| Setup + shared core | P0–P10 | Fri 09:00 |
| Facilitator + intents (the hard part) | P11–P15 | Fri 12:00 |
| Provider (paid service) | P16–P22 | Fri 15:00 |
| API core + World | P23–P28 | Fri 19:00 |
| Payer, approvals, resolver, results | P29–P34 | Fri 23:00 |
| **H1: local API + SSE ready for Frontend** | — | **Sat 00:00** |
| Agents, MCP, chaos, audit | P35–P41 | Sat 02:00 |
| Deploy + e2e on Railway (**H2**) | P42 | Sat 03:00 |
| **Feature freeze** | P46 | **Sat 04:00** |
| Docs, README, video | P43–P45 | Sat 08:00 |
| Submit | — | **Sat 08:30** (deadline 09:00) |

---
## Part II — Interface Control Document (ICD)

The ICD is the contract. Code in Part III implements it exactly. The Frontend doc copies ICD-7, ICD-8 and
ICD-11 verbatim. **If you change anything here, tell the frontend owner in the team chat in the same minute.**

### ICD-1 Repository layout and package names

```text
forkos/
├── package.json                 # pnpm workspace root (private)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docker-compose.yml           # local Postgres 16
├── .env.example                 # every variable in ICD-2
├── LICENSE                      # MIT
├── migrations/
│   └── 001_init.sql             # every table in ICD-13
├── deployments/
│   └── testnet.json             # written by bootstrap (ICD-4), committed (no secrets)
├── packages/
│   ├── shared/                  # @forkos/shared      env, constants, ids, hashing, hedera, mirror, hcs, arkiv, referee
│   ├── x402-hedera/             # @forkos/x402-hedera payment intents (death clock) + resolver   ← publishable
│   └── agent-kit/               # @forkos/agent-kit   agent-side: identity, discover, claim, wait-for-winner, api client
├── services/
│   ├── facilitator/             # @forkos/facilitator x402 facilitator for hedera:testnet (+ replay table)
│   ├── provider/                # @forkos/provider    paid transcription service "Scribe" (3 instances)
│   └── api/                     # @forkos/api         owners, World, agents, policy, payer, resolver, SSE, chaos
├── apps/
│   ├── mcp/                     # forkos-mcp          stdio MCP server: safe pay tool for any MCP agent
│   ├── agents/                  # @forkos/agents      demo agents (ForkOS lane + baseline lane)
│   ├── cli/                     # forkos              `forkos audit`, `forkos intent`
│   └── web/                     # FRONTEND (other doc)
├── scripts/                     # bootstrap, migrate, smoke tests, sample audio, e2e
├── docs/
│   ├── planning/                # this doc + the original README (disclosed)
│   ├── spec/x402-hedera-payment-intents.md
│   ├── threat-model.md
│   └── world-debrief.md
└── arkiv/                       # schema.md friction.md reach.md why-arkiv.md how-you-use-arkiv.md
```

Every package is `"type": "module"`, exports TypeScript source (`"exports": { ".": "./src/index.ts" }`), and
runs with **tsx** (dev and production). There is no build step except the frontend's.

### ICD-2 Environment variables

One `.env` at the repo root for local dev (loaded with `--env-file-if-exists`). On Railway, each service gets
only the variables in its column. **Never commit `.env`.**

| Variable | Example | facilitator | provider | api | agents/mcp/cli | Notes |
|---|---|:-:|:-:|:-:|:-:|---|
| `NODE_ENV` | `development` | ✓ | ✓ | ✓ | | |
| `DATABASE_URL` | `postgres://forkos:forkos@localhost:5432/forkos` | ✓ | ✓ | ✓ | | one DB, tables prefixed per service |
| `HEDERA_NETWORK` | `hedera:testnet` | ✓ | ✓ | ✓ | ✓ | only testnet is supported in this doc |
| `MIRROR_URL` | `https://testnet.mirrornode.hedera.com` | ✓ | ✓ | ✓ | ✓ | |
| `OPERATOR_ID` | `0.0.5001234` | | | ✓ | | portal account: treasury, topic admin, publishes LINK/INTENT/SETTLED/VOID/DONE |
| `OPERATOR_KEY` | `3030…` (DER) or `0x…` (hex ECDSA) | | | ✓ | | |
| `FACILITATOR_FEE_PAYER_ID` | `0.0.5001300` | ✓ | | | | created by bootstrap |
| `FACILITATOR_FEE_PAYER_KEY` | `0x…` | ✓ | | | | |
| `FACILITATOR_URL` | `http://localhost:4020` | | ✓ | ✓ | | api uses it only for chaos replay |
| `FACILITATOR_PORT` | `4020` | ✓ | | | | Railway sets `PORT`; code prefers `PORT` |
| `PAY_ASSET` | `0.0.5001299` | | ✓ | ✓ | ✓ | FUSD token id from deployments; `0.0.0` = HBAR fallback |
| `PAY_ASSET_DECIMALS` | `6` | | ✓ | ✓ | ✓ | `8` if HBAR |
| `HCS_TOPIC_ID` | `0.0.5001301` | | ✓ | ✓ | ✓ | from deployments |
| `PROVIDER_ID` | `scribe-a` | | ✓ | | | one of `scribe-a`, `scribe-b`, `scribe-premium` |
| `PROVIDER_NAME` | `Scribe A` | | ✓ | | | shown in directory |
| `PROVIDER_PRICE` | `50000` | | ✓ | | | smallest units (0.05 FUSD) |
| `PROVIDER_ACCOUNT_ID` | `0.0.5001302` | | ✓ | | | payTo + refunds |
| `PROVIDER_ACCOUNT_KEY` | `0x…` | | ✓ | | | signs refunds and REFUND messages |
| `PROVIDER_PUBLIC_URL` | `http://localhost:4031` | | ✓ | | | published in Arkiv directory (≤ 128 bytes) |
| `PROVIDER_PORT` | `4031` | | ✓ | | | |
| `PROVIDER_ARKIV_KEY` | `0x…` (secp256k1) | | ✓ | | | owner wallet of the provider's Service entity |
| `ARKIV_ACCESS_KEY` | `ak_…` | | ✓ | ✓ | ✓ | from hub.arkiv.network/access-keys |
| `API_ARKIV_KEY` | `0x…` | | | ✓ | | owner wallet of AgentLink entities; funds agent wallets with tGLM |
| `AGENT_ARKIV_FUND_WEI` | `50000000000000000` | | | ✓ | | 0.05 tGLM per new agent |
| `AGENT_HBAR_FUND` | `5` | | | ✓ | | HBAR per new agent account (HCS fees) |
| `HUMAN_FUSD_FUND` | `20000000` | | | ✓ | | 20 FUSD to each new human budget account |
| `HUMAN_HBAR_FUND` | `2` | | | ✓ | | small HBAR so the budget account can exist (fees are paid by the facilitator) |
| `API_PORT` | `4000` | | | ✓ | | |
| `API_PUBLIC_URL` | `http://localhost:4000` | | | ✓ | ✓ | |
| `WEB_ORIGIN` | `http://localhost:5173` | | | ✓ | | CORS allow-list (comma-separated) |
| `SESSION_SECRET` | 64 random hex chars | | | ✓ | | HMAC for owner session tokens |
| `KEY_ENCRYPTION_SECRET` | 64 random hex chars | | | ✓ | | AES-256-GCM for stored budget/agent keys |
| `HUMAN_SALT` | 64 random hex chars | | | ✓ | | salts `humanHash`; never changes after first use |
| `WORLD_ISSUER` | `https://auth.world.org` | | | ✓ | | or `https://sandbox.auth.world.org` (P4 decides) |
| `WORLD_CLIENT_ID` | `…` | | | ✓ | | from the World portal |
| `WORLD_CLIENT_SECRET` | `worldidp_client_secret_…` | | | ✓ | | **backend only** |
| `WORLD_SUB_STABLE` | `true` | | | ✓ | | `false` → pairing-code linking (P25) |
| `WORLD_FRESH_SECONDS` | `300` | | | ✓ | | max age of `auth_time` accepted |
| `POLICY_DEFAULT_CAP` | `1000000` | | | ✓ | | 1.00 FUSD autonomous per-payment cap |
| `POLICY_DEFAULT_DAILY` | `5000000` | | | ✓ | | 5.00 FUSD per day |
| `DEMO_KEY` | 32 random hex chars | | | ✓ | ✓ | protects `/v1/chaos/*` and demo-only routes |
| `OPENAI_API_KEY` | `sk-…` | | ✓ | | ✓ | |
| `OPENAI_MODEL` | `gpt-4.1-mini` | | ✓ | | ✓ | summaries + agent reasoning |
| `OPENAI_STT_MODEL` | `whisper-1` | | ✓ | | | transcription |
| `API_ARKIV_ADDRESS` | `0xabc…` | | ✓ | | | public address of `API_ARKIV_KEY` (provider trusts AgentLinks only from it) |
| `PROVIDER_ALLOW_CHAOS` | `true` | | ✓ | | | honours `x-forkos-chaos-fail` (refund demo) |
| `SAMPLE_AUDIO_URL` | `https://<scribe-a>/sample-meeting.mp3` | | | ✓ | | demo meeting audio |
| `FORKOS_API_URL` | `http://localhost:4000` | | | | ✓ | agents/mcp/cli |
| `FORKOS_AGENT_KEY` | `0x…` | | | | ✓ | one agent's secp256k1 key (mcp) |
| `FORKOS_AGENT_TOKEN` | `fat_…` | | | | ✓ | issued by the API after linking |

### ICD-3 Constants, ids and hashing (exact formulas)

All hashing is `sha256` over UTF-8, output **lowercase hex, 64 chars, no `0x`**, unless stated.

| Name | Formula | Example |
|---|---|---|
| `inputHash` | `"sha256:" + sha256(fileBytes)` | `sha256:9f86d0…` |
| `humanHash` | `sha256("forkos:human:v1|" + iss + "|" + sub + "|" + HUMAN_SALT)` | public, on HCS + Arkiv |
| `capability` | literal `"transcribe+summarize.v1"` | |
| `jobKey` | `sha256("forkos:job:v1|" + humanHash + "|" + capability + "|" + inputHash)` | same for every agent of one human buying the same thing |
| `jobShort` | first 16 chars of `jobKey` | used in memos and ids |
| `intentId` | `jobShort + "-r" + round` | `3fa1c0d2e4b6a8f0-r0` |
| `memo` | `"forkos:" + jobShort + ":r" + round` | ≤ 100 bytes (Hedera memo limit) |
| `agentAddr` | `viem privateKeyToAccount(key).address.toLowerCase()` | `0xabc…` (42 chars) |
| `digest` (approvals) | `sha256(canonicalJson(action))` | binds a World approval to one action |
| `canonicalJson` | JSON with object keys sorted recursively, no whitespace, bigints as decimal strings | |
| mirror tx id | SDK `0.0.X@S.N` → `0.0.X-S-N` (nanos stay 9 digits) | `0.0.9-1793909236-461971198` |

Death-clock and timing constants (`packages/shared/src/constants.ts`):

```ts
VALID_START_BACKDATE_S = 5      // validStart = now - 5 s
VALID_DURATION_S       = 120    // transaction dies at validStart + 120 s
RESEND_CUTOFF_S        = 10     // never resend with < 10 s left
VOID_MARGIN_S          = 45     // trust a Mirror 404 only after deadline + 45 s
CLAIM_WINDOW_S         = 30     // losing claims live 30 s on Arkiv (must be even: 2 s blocks)
APPROVAL_TTL_S         = 300    // a pending over-cap approval lives 5 min
MIRROR_WAIT_TIMEOUT_MS = 30000  // max wait for our own HCS message to appear on Mirror Node
```

### ICD-4 `deployments/testnet.json`

Written by `scripts/bootstrap-hedera.ts` (P6, P7). Contains **no private keys**.

```json
{
  "network": "hedera:testnet",
  "createdAt": "2026-11-06T03:10:00.000Z",
  "operatorId": "0.0.5001234",
  "token": { "id": "0.0.5001299", "symbol": "FUSD", "decimals": 6 },
  "topicId": "0.0.5001301",
  "facilitatorFeePayerId": "0.0.5001300",
  "providers": {
    "scribe-a":       { "accountId": "0.0.5001302", "price": "50000",   "name": "Scribe A" },
    "scribe-b":       { "accountId": "0.0.5001303", "price": "40000",   "name": "Scribe B" },
    "scribe-premium": { "accountId": "0.0.5001304", "price": "2000000", "name": "Scribe Premium" }
  },
  "baselineAgents": ["0.0.5001305", "0.0.5001306", "0.0.5001307"]
}
```

Keys created by bootstrap are printed **once** to the terminal and written to `.secrets/testnet-keys.json`
(git-ignored). Copy them into `.env` / Railway.

### ICD-5 HCS message schema (topic `HCS_TOPIC_ID`)

One public topic, **no submit key** (anyone can submit; validity is decided by the referee using the
Mirror Node `payer_account_id` of each message). Messages are compact JSON, **≤ 1024 bytes** (single chunk),
always `{"v":1,"t":"<TYPE>", …}`.

| `t` | Fields | Who submits (must equal `payer_account_id`) | Meaning |
|---|---|---|---|
| `LINK` | `human` (hex64), `agent` (0x addr), `acct` (0.0.X), `epoch` (int ≥ 1) | `OPERATOR_ID` | agent linked to human after World auth |
| `REVOKE` | `human`, `agent`, `epoch` (new epoch) | `OPERATOR_ID` | agent fired; epochs < this are stale |
| `CLAIM` | `job` (hex64), `round` (int ≥ 0), `human`, `agent`, `epoch`, `svc` (provider id), `price` (string), `ak` (Arkiv claim key, 0x…) | the agent's own account `acct` from its `LINK` | agent wants to buy this job round |
| `INTENT` | `job`, `round`, `agent`, `tx` (SDK tx id), `dl` (deadline, unix s), `amt`, `asset`, `payTo` | `OPERATOR_ID` | payer built and stored the intent |
| `SETTLED` | `job`, `round`, `tx`, `cts` (consensus timestamp) | `OPERATOR_ID` | Mirror Node shows SUCCESS |
| `VOID` | `job`, `round`, `tx` | `OPERATOR_ID` | proven void; next round opens |
| `DONE` | `job`, `round`, `svc`, `out` (hex64 output hash) | `OPERATOR_ID` | provider delivered |
| `REFUND` | `job`, `round`, `tx` (payment), `rtx` (refund tx), `amt` | the provider's account | provider refunded after failure |
| `APPROVAL` | `human`, `kind` (`LINK`\|`REVOKE`\|`OVERCAP`), `digest` (hex64) | `OPERATOR_ID` | World-validated approval (no PII) |

### ICD-6 Arkiv schemas (Rabdi)

Defined in `packages/shared/src/arkiv.ts`. Schema names are the `arkiv.schema` tag.

**`forkos.service.v1`** — owner: the provider's `PROVIDER_ARKIV_KEY` wallet. Lifetime 24 h, refreshed every 6 h.

| Column | Type | Indexed | Example |
|---|---|:-:|---|
| `providerId` | str | ✓ | `scribe-a` |
| `capability` | str | ✓ | `transcribe+summarize.v1` |
| `network` | str | ✓ | `hedera:testnet` |
| `asset` | str | ✓ | `0.0.5001299` |
| `price` | u64 | ✓ | `50000` |
| `name` | str | | `Scribe A` |
| `endpoint` | str | | `https://scribe-a.up.railway.app/v1/jobs` |
| `payTo` | str | | `0.0.5001302` |

**`forkos.agentlink.v1`** — owner: the API's `API_ARKIV_KEY` wallet. Lifetime 30 days.

| Column | Type | Indexed | Example |
|---|---|:-:|---|
| `human` | str | ✓ | humanHash |
| `agent` | str | ✓ | `0xabc…` |
| `status` | str | ✓ | `ACTIVE` \| `REVOKED` |
| `epoch` | u64 | ✓ | `1` |
| `acct` | str | | `0.0.5001400` |
| `label` | str | | `Claude Desktop` |

**`forkos.claim.v1`** — owner: **the agent's own wallet**. Lifetime `CLAIM_WINDOW_S` (30 s); the winner
extends it to the intent deadline + `VOID_MARGIN_S`; when PAID it is extended to 24 h as a receipt.

| Column | Type | Indexed | Example |
|---|---|:-:|---|
| `job` | str | ✓ | jobKey |
| `round` | u64 | ✓ | `0` |
| `human` | str | ✓ | humanHash |
| `agent` | str | ✓ | `0xabc…` |
| `status` | str | ✓ | `OPEN` → `WON`\|`LOST` → `PAYING` → `PAID`\|`VOID` |
| `epoch` | u64 | | `1` |
| `svc` | str | | `scribe-b` |
| `price` | u64 | | `40000` |
| `seq` | u64 | | HCS sequence number of the matching `CLAIM` (0 until known) |
| `tx` | str | | SDK tx id of the intent (empty until PAYING) |

### ICD-7 API HTTP endpoints (`services/api`, base `API_PUBLIC_URL`)

Auth kinds: **none**, **owner** (`Authorization: Bearer fos_…` owner session token), **agent**
(`Authorization: Bearer fat_…` agent token), **demo** (`X-Demo-Key: DEMO_KEY`).
All bodies are JSON. All errors are `{ "error": { "code": "<ICD-12 code>", "message": "…" } }`.

| Method & path | Auth | Request | Response 2xx |
|---|---|---|---|
| `GET /v1/health` | none | — | `{ok:true, network, topicId, asset, version}` |
| `GET /v1/config` | none | — | `{network, capability, topicId, operatorId, asset, assetDecimals, mirrorUrl, hashscan, providers:[{id,name,price,payTo}], baselineAgents, world:{issuer, subStable}}` |
| `POST /v1/owner/login/start` | none | `{}` | `{attemptId, userCode, verificationUri, verificationUriComplete, expiresIn, interval}` |
| `GET /v1/owner/login/:attemptId` | none | — | `{status:"PENDING"}` \| `{status:"DENIED"\|"EXPIRED"\|"FAILED", reason}` \| `{status:"APPROVED", token, human:{humanHash, budgetAccountId}}` |
| `GET /v1/me` | owner | — | `{humanHash, budgetAccountId, balance:{asset, amount, hbar}, policy, agents:[…], pairing?}` |
| `POST /v1/pairings` | owner | `{label}` | `{code, expiresAt}` (only used when `WORLD_SUB_STABLE=false`) |
| `POST /v1/agents/link/start` | none | `{agentAddr, publicKeyHex, label, pairingCode?}` | `{linkId, userCode, verificationUri, verificationUriComplete, expiresIn, interval}` |
| `GET /v1/agents/link/:linkId` | none | — | `{status:"PENDING"}` \| `{status:"DENIED"\|"EXPIRED"\|"FAILED", reason}` \| `{status:"LINKED", agentToken, agent:{agentAddr, accountId, epoch, humanHash}}` |
| `GET /v1/agents` | owner | — | `{agents:[{agentAddr, label, accountId, epoch, status, linkedAt, arkivKey}]}` |
| `POST /v1/agents/:agentAddr/revoke/start` | owner | `{replacement?: false}` | `{approvalId, userCode, verificationUri, verificationUriComplete, expiresIn, interval}` |
| `GET /v1/approvals/:approvalId` | owner | — | `{approvalId, kind, status:"PENDING"\|"APPROVED"\|"DENIED"\|"EXPIRED"\|"USED", action, digest, expiresAt}` |
| `POST /v1/approvals/:approvalId/cancel` | owner | — | `{status:"DENIED"}` |
| `GET /v1/policy` | owner | — | `{capPerPayment, dailyCap, allowlist:[providerId], spentToday}` |
| `PUT /v1/policy` | owner | `{capPerPayment?, dailyCap?, allowlist?}` | same as GET (tightening applies immediately; loosening requires nothing extra in this MVP) |
| `GET /v1/me/agent` | agent | — | `{agentAddr, humanHash, accountId, epoch, status}` |
| `GET /v1/jobs/:jobKey` | agent \| owner | — | `{jobKey, round, status, winner?, claims:[…], intent?, result?}` (ICD-11 job status) |
| `POST /v1/pay` | agent | `{jobKey, round, audioUrl, inputHash}` | `200 {status:"DONE", intent, result}` \| `202 {status:"APPROVAL_REQUIRED", approvalId, userCode, verificationUriComplete}` \| `202 {status:"PAYMENT_UNKNOWN", intent}` |
| `GET /v1/intents/:intentId` | agent \| owner | — | intent object (ICD-11) |
| `GET /v1/counter?jobKey=&since=` | none | — | `{jobKey, forkos:{payments, txs:[…]}, baseline:{payments, txs:[…]}, source:"mirror"}` |
| `GET /v1/directory` | none | — | `{services:[…]}` read **from Arkiv** |
| `GET /v1/board?jobKey=` | none | — | `{claims:[…]}` read **from Arkiv** |
| `GET /v1/timeline?jobKey=` | none | — | `{events:[…]}` read **from HCS via Mirror Node** |
| `GET /v1/events` | none | — | **SSE stream** (ICD-8) |
| `POST /v1/chaos/kill-next-payer` | demo | `{}` | `{armed:true}` |
| `POST /v1/chaos/replay/:intentId` | demo | — | `{facilitator:{…settle response, expect errorReason "forkos_replay_detected"…}}` |
| `POST /v1/chaos/fail-next-job` | demo | `{}` | `{armed:true}` (next job fails after payment → HTS refund) |
| `POST /v1/chaos/revive/:agentAddr` | demo | `{jobKey}` | `{provider:{status, body}}` (expect `409 STALE_AUTHORITY`) |
| `POST /v1/demo/job` | demo | `{}` | `{audioUrl, inputHash}` (the sample meeting) |

### ICD-8 SSE events (`GET /v1/events`)

`text/event-stream`. Each message: `event: <name>` and `data: <json>`. A `ping` comment every 15 s.

| Event | Data |
|---|---|
| `agent.linked` | `{humanHash, agentAddr, label, accountId, epoch}` |
| `agent.revoked` | `{humanHash, agentAddr, epoch}` |
| `claim.posted` | `{jobKey, round, agentAddr, svc, price, seq, arkivKey}` |
| `claim.won` | `{jobKey, round, agentAddr, seq}` |
| `claim.lost` | `{jobKey, round, agentAddr, seq, winnerSeq}` |
| `approval.pending` | `{approvalId, kind, humanHash, action, userCode, verificationUriComplete, expiresAt}` |
| `approval.resolved` | `{approvalId, kind, status}` |
| `intent.created` | `{intentId, jobKey, round, txId, deadline, amount, payTo}` |
| `payment.unknown` | `{intentId, txId, deadline}` |
| `payment.paid` | `{intentId, txId, consensusTimestamp, hashscan}` |
| `payment.void` | `{intentId, txId, provedAt}` |
| `job.done` | `{intentId, jobKey, outputHash, summary}` |
| `refund.sent` | `{jobKey, round, txId, refundTxId}` |
| `counter.update` | `{jobKey, forkos, baseline}` |
| `chaos` | `{kind, detail}` |

### ICD-9 Provider endpoints (`services/provider`, base `PROVIDER_PUBLIC_URL`)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | `{ok, providerId, price, payTo, arkivServiceKey}` |
| `POST /v1/jobs` | **x402** + ForkOS headers | the protected paid job (fenced) |
| `GET /v1/jobs/by-payment/:txId` | none | fetch result by payment tx id (reconcile after a lost response) |
| `POST /v1/baseline/jobs` | **x402** (stock `@x402/fastify` middleware) | the *naive* endpoint used by the baseline lane |

`POST /v1/jobs` headers: `X-ForkOS-Job` (jobKey), `X-ForkOS-Round`, `X-ForkOS-Agent` (agentAddr),
`X-ForkOS-Claim` (Arkiv claim key), plus x402 `PAYMENT-SIGNATURE` on the paid retry.
Body: `{ "audioUrl": "https://…", "inputHash": "sha256:…" }`.

Responses: `402` + `PAYMENT-REQUIRED` header (challenge or failed payment) · `409` fence failure
(`{error:{code:"STALE_AUTHORITY"|"NOT_WINNER"|"ALREADY_EXECUTED"|"ROUND_CLOSED"}}`) ·
`200 {jobId, txId, transcript, summary, outputHash}` + `PAYMENT-RESPONSE` header.

### ICD-10 Facilitator endpoints (`services/facilitator`)

Exactly the x402 facilitator contract: `GET /supported`, `POST /verify`, `POST /settle`; bodies
`{x402Version, paymentPayload, paymentRequirements}`; always `200` with `VerifyResponse`/`SettleResponse`.
Extra: `GET /health`, `GET /v1/settlements/:txId` (`{txId, status, attempts, lastError}`).

### ICD-11 State machines

**Intent** (`api.intents.status`):

```text
CREATED ─send──▶ SENT ─200──────────────▶ PAID ──job ok──▶ DONE
   │              │                         └─job failed─▶ REFUNDED (provider refunds)
   │              ├─402/verify invalid─▶ REJECTED (money did not move; Mirror confirms 404 after clock → VOID)
   │              └─timeout/abort/5xx──▶ PAYMENT_UNKNOWN ─resolver─▶ PAID | FAILED | VOID
   └─policy over cap─▶ (no intent yet; approval created)
```

**Claim** (Arkiv `status`): `OPEN → WON | LOST`, `WON → PAYING → PAID | VOID`.

**Job** (`GET /v1/jobs/:jobKey` → `status`): `OPEN` (no valid claim in current round) · `CLAIMED` (winner
known, no intent) · `PAYING` · `PAID` · `DONE` · `REFUNDED`. `round` = number of `VOID`s for the job.

**Approval:** `PENDING → APPROVED → USED`, `PENDING → DENIED | EXPIRED`.

**Agent link:** `PENDING → LINKED (ACTIVE) → REVOKED`; `PENDING → DENIED | EXPIRED`.

### ICD-12 Error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | zod validation failed |
| 401 | `UNAUTHORIZED` | missing/invalid token |
| 403 | `FORBIDDEN` | wrong owner, demo key missing |
| 404 | `NOT_FOUND` | unknown id |
| 409 | `NOT_WINNER` | agent is not the HCS winner of that round |
| 409 | `ROUND_CLOSED` | round already PAID/DONE or VOID (use current round) |
| 409 | `STALE_AUTHORITY` | agent revoked or epoch outdated |
| 409 | `ALREADY_EXECUTED` | provider already ran this job |
| 409 | `APPROVAL_MISMATCH` | approval digest ≠ action digest |
| 402 | `POLICY_DENIED` | not in allowlist / over daily cap |
| 410 | `APPROVAL_EXPIRED` | approval past TTL |
| 422 | `INPUT_HASH_MISMATCH` | downloaded audio hash ≠ `inputHash` |
| 502 | `UPSTREAM_FAILED` | provider/facilitator/World/Arkiv error |
| 503 | `WORLD_UNAVAILABLE` | World returned 503 (never treated as approval) |

### ICD-13 Postgres schema

All tables live in one database. Prefix = owning service (`fac_`, `prov_`, none for api). Full SQL is in
P11 (`migrations/001_init.sql`). Summary:

| Table | Key | Purpose |
|---|---|---|
| `fac_settlements` | `tx_id` PK | facilitator replay table |
| `prov_jobs` | `id` PK, unique `payment_tx_id`, unique partial `(job_key) where status in ('RUNNING','DONE')` | provider job ledger |
| `humans` | `human_hash` PK, unique `(iss, sub)` | owners + encrypted budget account key |
| `owner_sessions` | `token_hash` PK | owner bearer tokens (hashed) |
| `world_attempts` | `id` PK | every device-flow attempt (login/link/revoke/overcap) |
| `pairings` | `code` PK | pairing codes (sub-unstable mode) |
| `agents` | `agent_addr` PK | linked agents, epoch, encrypted nothing (agents keep their own keys) |
| `agent_tokens` | `token_hash` PK | agent bearer tokens (hashed) |
| `policies` | `human_hash` PK | cap, daily, allowlist |
| `approvals` | `id` PK | over-cap + revoke approvals with digest |
| `intents` | `id` PK, unique `(job_key, round)`, unique `tx_id` | payment intents (stored before sending) |
| `events` | `id` bigserial | everything sent over SSE (replayable) |

---
## Part III — Build phases

**How to read a phase**

- **Goal** – what exists when you finish. **Time** – honest estimate. **Depends** – phases that must be done.
- **Files** – every file you create or change, with full content. Copy them exactly.
- **Commands** – run from the repo root unless a `cd` is shown.
- **Exit checks** – all must pass before you commit. If one fails, fix it (Part V) before moving on.
- **Commit** – exact message. Push after every commit (commit history is judged).

---

### Phase P0 — Machine setup, accounts and keys

**Goal:** every tool installed at the right version; every external account exists; you have the secrets
you need in a password manager (not in git). **Time:** 30 min. **Depends:** nothing.

**Tools**

```bash
node --version            # must be >= v22.10 (Arkiv SDK needs 22.10+; --env-file-if-exists needs 22.9+)
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm --version            # 9.15.0
docker --version          # any recent Docker (local Postgres)
git --version
```

If `node` is older, install Node 22 LTS (nvm: `nvm install 22 && nvm use 22`).

**Accounts to create (do them in parallel with P1)**

| # | What | Where | You get |
|---|---|---|---|
| A1 | Hedera testnet **operator** | `https://portal.hedera.com/playground` → sign up → **CREATE ACCOUNT** | Account id `0.0.X` + **DER private key starting `303…`** (ECDSA), funded with 1000 HBAR |
| A2 | Extra test HBAR (only if A1 runs low) | `https://portal.hedera.com/faucet` | +100 HBAR per request |
| A3 | Arkiv access key | `https://hub.arkiv.network/access-keys` | `ARKIV_ACCESS_KEY` |
| A4 | Arkiv test gas (tGLM) | `https://hub.arkiv.network/faucet` | fund the **API** and **provider** Arkiv wallets (addresses come from P1) |
| A5 | World ID client | portal (P4 decides production `https://auth.world.org/portal` vs sandbox `https://sandbox.auth.world.org/portal`) | `WORLD_CLIENT_ID`, `WORLD_CLIENT_SECRET` (shown once) |
| A6 | OpenAI | `https://platform.openai.com/api-keys` | `OPENAI_API_KEY` |
| A7 | Railway | `https://railway.app` (GitHub login) | used in P42 |
| A8 | GitHub repo | `forkos` (public) | push after every phase |

**Secrets handling rules (read once)**

- Private keys and secrets go in `.env` (git-ignored) and Railway variables. Never in code, logs, HCS, Arkiv,
  or chat with an AI assistant.
- The operator key controls the FUSD treasury and the referee topic admin. Treat it like a production key.

**Exit checks**

- [ ] `node --version` ≥ 22.10, `pnpm --version` = 9.15.0, Docker running
- [ ] A1 done: you have `OPERATOR_ID` and a DER key starting `303`
- [ ] A3 done, A6 done
- [ ] A5 started (finished in P4)

**Commit:** nothing to commit.

---

### Phase P1 — Monorepo skeleton

**Goal:** a pnpm workspace with every folder, pinned dependencies, TypeScript config, licence, env template,
local Postgres. **Time:** 40 min. **Depends:** P0.

**Commands**

```bash
mkdir forkos && cd forkos
git init -b main
mkdir -p packages/shared/src packages/shared/test \
         packages/x402-hedera/src packages/x402-hedera/test \
         packages/agent-kit/src \
         services/facilitator/src services/provider/src services/provider/public services/api/src/routes \
         apps/mcp/src apps/agents/src apps/cli/src \
         scripts migrations deployments docs/planning docs/spec arkiv .secrets
```

**File: `package.json`**

```json
{
  "name": "forkos",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22.10" },
  "scripts": {
    "db:up": "docker compose up -d db",
    "db:down": "docker compose down",
    "db:migrate": "tsx --env-file-if-exists=.env scripts/migrate.ts",
    "keys:new": "tsx scripts/new-keys.ts",
    "bootstrap:hedera": "tsx --env-file-if-exists=.env scripts/bootstrap-hedera.ts",
    "smoke:arkiv": "tsx --env-file-if-exists=.env scripts/smoke-arkiv.ts",
    "smoke:hcs": "tsx --env-file-if-exists=.env scripts/smoke-hcs.ts",
    "smoke:pay": "tsx --env-file-if-exists=.env scripts/smoke-pay.ts",
    "smoke:world": "tsx --env-file-if-exists=.env scripts/smoke-world.ts",
    "audio:sample": "tsx --env-file-if-exists=.env scripts/make-sample-audio.ts",
    "dev:facilitator": "pnpm --filter @forkos/facilitator dev",
    "dev:scribe-a": "pnpm --filter @forkos/provider dev:a",
    "dev:scribe-b": "pnpm --filter @forkos/provider dev:b",
    "dev:scribe-premium": "pnpm --filter @forkos/provider dev:premium",
    "dev:api": "pnpm --filter @forkos/api dev",
    "agents": "pnpm --filter @forkos/agents start",
    "baseline": "pnpm --filter @forkos/agents baseline",
    "mcp": "pnpm --filter forkos-mcp start",
    "forkos": "pnpm --filter forkos start",
    "e2e": "tsx --env-file-if-exists=.env scripts/e2e.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.20.0",
    "typescript": "~5.9.3",
    "vitest": "^3.2.0"
  }
}
```

**File: `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "services/*"
  - "apps/*"
```

**File: `.npmrc`**

```ini
# One copy of each dependency where possible (important: exactly one @hiero-ledger/sdk)
auto-install-peers=true
strict-peer-dependencies=false
```

**File: `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": false,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  }
}
```

**File: `tsconfig.json`** (type-checks the whole repo in one go)

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["packages/*/src", "packages/*/test", "services/*/src", "apps/mcp/src", "apps/agents/src", "apps/cli/src", "scripts"]
}
```

**File: `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
```

**File: `.gitignore`**

```gitignore
node_modules/
.env
.env.*
!.env.example
.secrets/
*.log
.DS_Store
apps/web/dist/
services/provider/public/*.mp3
!services/provider/public/sample-meeting.mp3
coverage/
```

**File: `LICENSE`** — MIT (required: Arkiv "open-source licence", ETHGlobal open source).

```text
MIT License

Copyright (c) 2026 ForkOS contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**File: `docker-compose.yml`**

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: forkos
      POSTGRES_PASSWORD: forkos
      POSTGRES_DB: forkos
    ports:
      - "5432:5432"
    volumes:
      - forkos-db:/var/lib/postgresql/data
volumes:
  forkos-db:
```

**File: `.env.example`** (every variable from ICD-2; values in `<>` are filled in later phases)

```dotenv
NODE_ENV=development
DATABASE_URL=postgres://forkos:forkos@localhost:5432/forkos
HEDERA_NETWORK=hedera:testnet
MIRROR_URL=https://testnet.mirrornode.hedera.com

# Hedera operator (portal account, P0 A1)
OPERATOR_ID=<0.0.X>
OPERATOR_KEY=<DER key starting 303...>

# Filled from deployments/testnet.json + .secrets/testnet-keys.json after P6/P7
PAY_ASSET=<FUSD token id>
PAY_ASSET_DECIMALS=6
HCS_TOPIC_ID=<topic id>
FACILITATOR_FEE_PAYER_ID=<0.0.X>
FACILITATOR_FEE_PAYER_KEY=<0x...>
FACILITATOR_URL=http://localhost:4020
FACILITATOR_PORT=4020

# Arkiv (P0 A3 + P1 keys:new)
ARKIV_ACCESS_KEY=<ak_...>
API_ARKIV_KEY=<0x...>
PROVIDER_ARKIV_KEY=<0x...>
AGENT_ARKIV_FUND_WEI=50000000000000000
AGENT_HBAR_FUND=5
HUMAN_FUSD_FUND=20000000
HUMAN_HBAR_FUND=2

# API
API_PORT=4000
API_PUBLIC_URL=http://localhost:4000
WEB_ORIGIN=http://localhost:5173
SESSION_SECRET=<64 hex>
KEY_ENCRYPTION_SECRET=<64 hex>
HUMAN_SALT=<64 hex>
POLICY_DEFAULT_CAP=1000000
POLICY_DEFAULT_DAILY=5000000
DEMO_KEY=<32 hex>

# World ID (P4)
WORLD_ISSUER=https://auth.world.org
WORLD_CLIENT_ID=<client id>
WORLD_CLIENT_SECRET=<worldidp_client_secret_...>
WORLD_SUB_STABLE=true
WORLD_FRESH_SECONDS=300

# OpenAI
OPENAI_API_KEY=<sk-...>
OPENAI_MODEL=gpt-4.1-mini
OPENAI_STT_MODEL=whisper-1

# Agents / MCP / CLI
FORKOS_API_URL=http://localhost:4000
FORKOS_AGENT_KEY=<0x... from keys:new>
FORKOS_AGENT_TOKEN=<fat_... after linking>
```

**Provider instance overlays** (each one overrides only these; the root `.env` holds everything else):

**File: `.env.scribe-a`**

```dotenv
PROVIDER_ID=scribe-a
PROVIDER_NAME=Scribe A
PROVIDER_PRICE=50000
PROVIDER_PORT=4031
PROVIDER_PUBLIC_URL=http://localhost:4031
PROVIDER_ACCOUNT_ID=<from deployments>
PROVIDER_ACCOUNT_KEY=<from .secrets>
```

**File: `.env.scribe-b`**

```dotenv
PROVIDER_ID=scribe-b
PROVIDER_NAME=Scribe B
PROVIDER_PRICE=40000
PROVIDER_PORT=4032
PROVIDER_PUBLIC_URL=http://localhost:4032
PROVIDER_ACCOUNT_ID=<from deployments>
PROVIDER_ACCOUNT_KEY=<from .secrets>
```

**File: `.env.scribe-premium`**

```dotenv
PROVIDER_ID=scribe-premium
PROVIDER_NAME=Scribe Premium
PROVIDER_PRICE=2000000
PROVIDER_PORT=4033
PROVIDER_PUBLIC_URL=http://localhost:4033
PROVIDER_ACCOUNT_ID=<from deployments>
PROVIDER_ACCOUNT_KEY=<from .secrets>
```

> `.env.*` files are git-ignored by the rule `.env.*`. That is intended: they contain provider keys.

**Package manifests** — create all of them now so one `pnpm install` resolves everything. **Pin
`@hiero-ledger/sdk` to exactly `2.90.1` everywhere** (the version `@x402/hedera@2.30.0` pins), so there is a
single copy of the SDK in `node_modules`.

**File: `packages/shared/package.json`**

```json
{
  "name": "@forkos/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@arkiv-network/sdk": "1.0.1",
    "@hiero-ledger/sdk": "2.90.1",
    "viem": "^2.40.0",
    "zod": "^3.25.0"
  }
}
```

**File: `packages/x402-hedera/package.json`**

```json
{
  "name": "@forkos/x402-hedera",
  "version": "0.1.0",
  "description": "Payment intents with a death clock for x402 on Hedera: paid exactly once, or provably never.",
  "license": "MIT",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@forkos/shared": "workspace:*",
    "@hiero-ledger/sdk": "2.90.1",
    "@x402/core": "2.30.0",
    "@x402/hedera": "2.30.0"
  }
}
```

**File: `packages/agent-kit/package.json`**

```json
{
  "name": "@forkos/agent-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@arkiv-network/sdk": "1.0.1",
    "@forkos/shared": "workspace:*",
    "@hiero-ledger/sdk": "2.90.1",
    "viem": "^2.40.0",
    "zod": "^3.25.0"
  }
}
```

**File: `services/facilitator/package.json`**

```json
{
  "name": "@forkos/facilitator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=../../.env src/index.ts",
    "start": "tsx src/index.ts"
  },
  "dependencies": {
    "@forkos/shared": "workspace:*",
    "@hiero-ledger/sdk": "2.90.1",
    "@x402/core": "2.30.0",
    "@x402/hedera": "2.30.0",
    "fastify": "^5.6.0",
    "postgres": "3.4.9",
    "zod": "^3.25.0"
  }
}
```

**File: `services/provider/package.json`**

```json
{
  "name": "@forkos/provider",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:a": "tsx watch --env-file-if-exists=../../.env --env-file-if-exists=../../.env.scribe-a src/index.ts",
    "dev:b": "tsx watch --env-file-if-exists=../../.env --env-file-if-exists=../../.env.scribe-b src/index.ts",
    "dev:premium": "tsx watch --env-file-if-exists=../../.env --env-file-if-exists=../../.env.scribe-premium src/index.ts",
    "start": "tsx src/index.ts"
  },
  "dependencies": {
    "@arkiv-network/sdk": "1.0.1",
    "@fastify/static": "^8.2.0",
    "@forkos/shared": "workspace:*",
    "@hiero-ledger/sdk": "2.90.1",
    "@x402/core": "2.30.0",
    "@x402/fastify": "2.30.0",
    "@x402/hedera": "2.30.0",
    "fastify": "^5.6.0",
    "openai": "^7.52.0",
    "postgres": "3.4.9",
    "viem": "^2.40.0",
    "zod": "^3.25.0"
  }
}
```

**File: `services/api/package.json`**

```json
{
  "name": "@forkos/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=../../.env src/index.ts",
    "start": "tsx src/index.ts"
  },
  "dependencies": {
    "@arkiv-network/sdk": "1.0.1",
    "@fastify/cors": "^11.0.0",
    "@forkos/shared": "workspace:*",
    "@forkos/x402-hedera": "workspace:*",
    "@hiero-ledger/sdk": "2.90.1",
    "@x402/core": "2.30.0",
    "@x402/hedera": "2.30.0",
    "fastify": "^5.6.0",
    "jose": "^6.0.0",
    "postgres": "3.4.9",
    "viem": "^2.40.0",
    "zod": "^3.25.0"
  }
}
```

**File: `apps/mcp/package.json`**

```json
{
  "name": "forkos-mcp",
  "version": "0.1.0",
  "description": "MCP server that gives any agent a safe, exactly-once pay tool (ForkOS).",
  "license": "MIT",
  "type": "module",
  "bin": { "forkos-mcp": "./src/index.ts" },
  "scripts": { "start": "tsx --env-file-if-exists=../../.env src/index.ts" },
  "dependencies": {
    "@forkos/agent-kit": "workspace:*",
    "@forkos/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.32.0",
    "zod": "^3.25.0"
  }
}
```

**File: `apps/agents/package.json`**

```json
{
  "name": "@forkos/agents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx --env-file-if-exists=../../.env src/run.ts",
    "baseline": "tsx --env-file-if-exists=../../.env src/baseline.ts",
    "link": "tsx --env-file-if-exists=../../.env src/link.ts"
  },
  "dependencies": {
    "@forkos/agent-kit": "workspace:*",
    "@forkos/shared": "workspace:*",
    "@hiero-ledger/sdk": "2.90.1",
    "@x402/core": "2.30.0",
    "@x402/fetch": "2.30.0",
    "@x402/hedera": "2.30.0",
    "openai": "^7.52.0",
    "zod": "^3.25.0"
  }
}
```

**File: `apps/cli/package.json`**

```json
{
  "name": "forkos",
  "version": "0.1.0",
  "description": "ForkOS CLI: audit exactly-once agent payments from Hedera Mirror Node.",
  "license": "MIT",
  "type": "module",
  "bin": { "forkos": "./src/index.ts" },
  "scripts": { "start": "tsx --env-file-if-exists=../../.env src/index.ts" },
  "dependencies": {
    "@forkos/shared": "workspace:*",
    "commander": "^12.1.0"
  }
}
```

Placeholder entry points so the workspace resolves (each is replaced later):

**File: `packages/shared/src/index.ts`**

```ts
export {};
```

**File: `packages/x402-hedera/src/index.ts`**

```ts
export {};
```

**File: `packages/agent-kit/src/index.ts`**

```ts
export {};
```

**File: `scripts/new-keys.ts`** — generates secp256k1 keys for Arkiv wallets, agents and secrets.

```ts
// Usage: pnpm keys:new            → prints 3 Arkiv wallets + 4 random secrets
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
  wallet('API_ARKIV_KEY');
  wallet('PROVIDER_ARKIV_KEY');
  wallet('FORKOS_AGENT_KEY');
  for (const name of ['SESSION_SECRET', 'KEY_ENCRYPTION_SECRET', 'HUMAN_SALT']) {
    console.log(`${name}=${randomBytes(32).toString('hex')}`);
  }
  console.log(`DEMO_KEY=${randomBytes(16).toString('hex')}`);
}
```

> `scripts/` uses `viem` from the workspace root. Add it to the root as a dev dependency in the command below.

**Commands**

```bash
pnpm add -w -D viem@^2.40.0 @hiero-ledger/sdk@2.90.1 @arkiv-network/sdk@1.0.1 \
  @x402/core@2.30.0 @x402/hedera@2.30.0 openai@^7.52.0 postgres@3.4.9 zod@^3.25.0
pnpm install
cp .env.example .env
pnpm keys:new                # paste output into .env
pnpm db:up
pnpm ls @hiero-ledger/sdk -r --depth 0 | sort -u   # every line must say 2.90.1
```

Fund the **API_ARKIV_KEY** and **PROVIDER_ARKIV_KEY** addresses printed by `keys:new` at
`https://hub.arkiv.network/faucet` (P0 A4).

**Exit checks**

- [ ] `pnpm install` finishes with no errors
- [ ] `pnpm ls @hiero-ledger/sdk -r` shows only `2.90.1`
- [ ] `docker compose ps` shows `db` running; `psql postgres://forkos:forkos@localhost:5432/forkos -c 'select 1'` works (or `docker compose exec db psql -U forkos -c 'select 1'`)
- [ ] `.env` contains the 3 Arkiv keys and 4 secrets; `git status` does **not** list `.env` or `.secrets/`
- [ ] Both Arkiv wallet addresses show a tGLM balance on `https://rabdi.explorer.arkiv.network`

**Commit:** `chore: monorepo skeleton, pinned deps, env template, local postgres`

---

### Phase P2 — Shared: constants, env loader, errors

**Goal:** one source of truth for constants, typed environment loading, and the API error type.
**Time:** 20 min. **Depends:** P1.

**File: `packages/shared/src/constants.ts`**

```ts
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
```

**File: `packages/shared/src/env.ts`**

```ts
import { z } from 'zod';

export const zHederaId = z.string().regex(/^0\.0\.\d+$/, 'expected a Hedera id like 0.0.1234');
export const zHex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars');
export const zEvmAddr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected an EVM address')
  .transform((s) => s.toLowerCase());
export const zPrivHex = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x + 64 hex chars');
export const zIntString = z.string().regex(/^\d+$/, 'expected a non-negative integer string');

/**
 * Validates process.env against a zod shape and returns typed values.
 * Throws one readable error listing every problem (fail fast at boot).
 */
export function loadEnv<T extends z.ZodRawShape>(shape: T): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Railway injects PORT; locally we use the service-specific variable. */
export function portFrom(fallbackVar: string, fallback: number): number {
  const raw = process.env.PORT ?? process.env[fallbackVar];
  const n = raw ? Number(raw) : fallback;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid port in PORT/${fallbackVar}: ${raw}`);
  return n;
}
```

**File: `packages/shared/src/errors.ts`**

```ts
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'NOT_WINNER'
  | 'ROUND_CLOSED'
  | 'STALE_AUTHORITY'
  | 'ALREADY_EXECUTED'
  | 'APPROVAL_MISMATCH'
  | 'POLICY_DENIED'
  | 'APPROVAL_EXPIRED'
  | 'INPUT_HASH_MISMATCH'
  | 'UPSTREAM_FAILED'
  | 'WORLD_UNAVAILABLE';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_WINNER: 409,
  ROUND_CLOSED: 409,
  STALE_AUTHORITY: 409,
  ALREADY_EXECUTED: 409,
  APPROVAL_MISMATCH: 409,
  POLICY_DENIED: 402,
  APPROVAL_EXPIRED: 410,
  INPUT_HASH_MISMATCH: 422,
  UPSTREAM_FAILED: 502,
  WORLD_UNAVAILABLE: 503,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}
```

**File: `packages/shared/src/index.ts`** (replace the placeholder; grows in later phases)

```ts
export * from './constants';
export * from './env';
export * from './errors';
```

**Exit checks**

- [ ] `pnpm typecheck` passes

**Commit:** `feat(shared): constants, typed env loader, api error type`

---

### Phase P3 — Shared: hashing and ids

**Goal:** the exact formulas from ICD-3, with tests that pin them. **Time:** 25 min. **Depends:** P2.

**File: `packages/shared/src/hash.ts`**

```ts
import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic JSON: object keys sorted recursively, no whitespace, bigint → decimal string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[k];
      if (child !== undefined) out[k] = sortValue(child);
    }
    return out;
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}
```

**File: `packages/shared/src/ids.ts`**

```ts
import { CAPABILITY } from './constants';
import { canonicalJson, sha256Hex } from './hash';

export function inputHashOf(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

export function humanHashOf(iss: string, sub: string, salt: string): string {
  return sha256Hex(`forkos:human:v1|${iss}|${sub}|${salt}`);
}

export function jobKeyOf(humanHash: string, inputHash: string, capability: string = CAPABILITY): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(inputHash)) throw new Error(`bad inputHash: ${inputHash}`);
  return sha256Hex(`forkos:job:v1|${humanHash}|${capability}|${inputHash}`);
}

export function jobShort(jobKey: string): string {
  return jobKey.slice(0, 16);
}

export function intentIdOf(jobKey: string, round: number): string {
  return `${jobShort(jobKey)}-r${round}`;
}

export function memoOf(jobKey: string, round: number): string {
  return `forkos:${jobShort(jobKey)}:r${round}`;
}

/** Parses a memo written by memoOf; returns null for anything else. */
export function parseMemo(memo: string): { jobShort: string; round: number } | null {
  const m = /^forkos:([0-9a-f]{16}):r(\d+)$/.exec(memo);
  return m ? { jobShort: m[1]!, round: Number(m[2]) } : null;
}

export function digestOf(action: unknown): string {
  return sha256Hex(canonicalJson(action));
}
```

**File: `packages/shared/test/ids.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/hash';
import { humanHashOf, intentIdOf, jobKeyOf, memoOf, parseMemo } from '../src/ids';

const SALT = '00'.repeat(32);

describe('ids (ICD-3 vectors)', () => {
  it('humanHash vector', () => {
    expect(humanHashOf('https://auth.world.org', 'sub_test_123', SALT)).toBe(
      'b57fdd6077da84aa6a555e0a9e04b4cc06580bddcb6662645a4b805e52de20eb',
    );
  });

  it('inputHash + jobKey vector', () => {
    const inputHash = `sha256:${sha256Hex('hello forkos')}`;
    expect(inputHash).toBe('sha256:2ea16b944da28393b1e68c9514a99a032b72339c1a4c10893c670a607d1cfc5b');
    const human = humanHashOf('https://auth.world.org', 'sub_test_123', SALT);
    expect(jobKeyOf(human, inputHash)).toBe('11f22571df7398b5c394fd97ead7ca0d0f015d4016fe9bff8903ccf436b656f7');
  });

  it('memo is short and round-trips', () => {
    const job = '11f22571df7398b5c394fd97ead7ca0d0f015d4016fe9bff8903ccf436b656f7';
    expect(memoOf(job, 0)).toBe('forkos:11f22571df7398b5:r0');
    expect(Buffer.byteLength(memoOf(job, 999))).toBeLessThanOrEqual(100);
    expect(parseMemo(memoOf(job, 3))).toEqual({ jobShort: '11f22571df7398b5', round: 3 });
    expect(parseMemo('hello')).toBeNull();
    expect(intentIdOf(job, 2)).toBe('11f22571df7398b5-r2');
  });

  it('canonicalJson sorts keys deeply and stringifies bigint', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }], n: 10n })).toBe('{"a":[{"c":"x","d":2}],"b":1,"n":"10"}');
  });

  it('rejects malformed inputHash', () => {
    expect(() => jobKeyOf('aa', 'md5:abc')).toThrow();
  });
});
```

Add to `packages/shared/src/index.ts`:

```ts
export * from './hash';
export * from './ids';
```

**Exit checks**

- [ ] `pnpm test` → 5 tests pass (the three vectors are the values in ICD-3 / this doc; if one differs, your formula is wrong, not the vector)
- [ ] `pnpm typecheck` passes

**Commit:** `feat(shared): canonical hashing, humanHash/jobKey/memo ids with pinned vectors`

---

### Phase P4 — World ID client registration and environment check

**Goal:** a registered World OIDC **confidential** client, the correct issuer chosen, and a script that proves
discovery + device authorization start work. **Time:** 30 min. **Depends:** P1.

**Which environment?** The Mumbai prize page says *"We are mocking proofs now, so you don't need sandbox app
anymore"* and links to `https://auth.world.org`. The World docs also describe a sandbox issuer
`https://sandbox.auth.world.org` that needs the sandbox World ID app. **Ask at the World booth which issuer
the mocked proofs use**, then register there. Everything in the code reads `WORLD_ISSUER`, so switching is a
one-line change.

**Portal steps**

1. Open the portal of the chosen issuer (`<issuer>/portal`) and sign in with Google.
2. Create an application / OIDC client:
   - **Client authentication method:** `client_secret_post` (we send `client_id` + `client_secret` in the
     form body — matches the docs' device-flow examples). The method cannot be changed later.
   - **Redirect URI:** register `https://<your-api-domain>/v1/world/callback` (required even for device-only
     clients; we never use it). Use `https://example.com/forkos/callback` for now if you have no domain yet.
   - **Accepted accounts:** `Any account` while testing with mocks (so test identities are accepted); note
     the choice for the debrief.
3. Copy the **client id** and the **client secret** (shown once; starts with `worldidp_client_secret_`) into `.env`.
4. Write down in `docs/world-debrief.md` (create it now, fill in P44): the time you started, the time of
   first success, anything confusing.

**File: `docs/world-debrief.md`** (skeleton; completed in P44)

```markdown
# World ID Agent Pass — integration debrief

- Issuer used: <!-- https://auth.world.org or https://sandbox.auth.world.org -->
- Client auth method: client_secret_post · Flow: Device Authorization Grant (RFC 8628)
- Started integration: <!-- time -->
- Time to first success (validated id_token in backend): <!-- minutes -->

## What we built with it
## Friction we hit
## Missing capability or documentation
## The one improvement with the greatest impact
```

**File: `scripts/smoke-world.ts`**

```ts
// Proves: discovery is reachable, the device endpoint exists, and our client credentials are accepted.
// Usage: pnpm smoke:world            → starts a device authorization and prints the user code
//        pnpm smoke:world poll <device_code>
export {};
const issuer = process.env.WORLD_ISSUER;
const clientId = process.env.WORLD_CLIENT_ID;
const clientSecret = process.env.WORLD_CLIENT_SECRET;
if (!issuer || !clientId || !clientSecret) throw new Error('Set WORLD_ISSUER, WORLD_CLIENT_ID, WORLD_CLIENT_SECRET');

const disco = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
console.log('issuer:', disco.issuer);
console.log('device_authorization_endpoint:', disco.device_authorization_endpoint);
console.log('token_endpoint:', disco.token_endpoint);
console.log('jwks_uri:', disco.jwks_uri);
console.log('grant_types_supported:', disco.grant_types_supported);

if (process.argv[2] === 'poll') {
  const deviceCode = process.argv[3];
  if (!deviceCode) throw new Error('usage: pnpm smoke:world poll <device_code>');
  const res = await fetch(String(disco.token_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(res.status, body.error ?? 'tokens received');
  if (typeof body.id_token === 'string') {
    const payload = JSON.parse(Buffer.from(body.id_token.split('.')[1]!, 'base64url').toString());
    // Only for this smoke test: print claim NAMES and the sub prefix, never the token itself.
    console.log('claims:', Object.keys(payload).join(','), 'sub prefix:', String(payload.sub).slice(0, 8));
  }
} else {
  const res = await fetch(String(disco.device_authorization_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'openid' }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`device_authorization failed ${res.status}: ${JSON.stringify(body)}`);
  console.log('user_code:', body.user_code);
  console.log('verification_uri_complete:', body.verification_uri_complete);
  console.log('expires_in:', body.expires_in, 'interval:', body.interval);
  console.log(`\nApprove it on your phone, then run:\n  pnpm smoke:world poll ${String(body.device_code)}`);
}
```

**Commands**

```bash
pnpm smoke:world
# open verification_uri_complete on a phone, approve with the (mock) World ID, then:
pnpm smoke:world poll <device_code>
# run the whole thing a SECOND time with the same identity and compare the printed sub prefix
```

**Exit checks**

- [ ] Discovery prints a `device_authorization_endpoint` and `token_endpoint` (expected `…/api/v1/device_authorization`, `…/api/v1/token`)
- [ ] Device start returns `user_code` and `verification_uri_complete`
- [ ] After approving, poll prints `tokens received` and claims include `sub,auth_time,acr,amr` (no `nonce` — expected for device flow)
- [ ] **Sub stability:** two approvals with the same identity print the **same** sub prefix → keep `WORLD_SUB_STABLE=true`; different → set `WORLD_SUB_STABLE=false` and note it in the debrief
- [ ] Cancelling on the phone makes poll print `access_denied`

**Commit:** `chore(world): register client, smoke test device flow, debrief skeleton`

---

### Phase P5 — Shared: Hedera helpers and Mirror Node client

**Goal:** key parsing, operator clients, tx-id conversion, HashScan links, and a small typed Mirror Node
client used by every service. **Time:** 40 min. **Depends:** P2.

**File: `packages/shared/src/hedera.ts`**

```ts
import { AccountId, Client, PrivateKey, Timestamp, TransactionId } from '@hiero-ledger/sdk';
import { HASHSCAN_BASE } from './constants';

/**
 * Accepts the two formats we use:
 *  - DER hex (portal keys start with 30…; ECDSA DER starts 3030…, ED25519 DER starts 302e…)
 *  - 32-byte ECDSA hex with or without 0x (keys we generate)
 */
export function parsePrivateKey(raw: string): PrivateKey {
  const s = raw.trim();
  const hex = s.startsWith('0x') ? s.slice(2) : s;
  if (/^30[0-9a-fA-F]{60,}$/.test(hex) && hex.length > 64) return PrivateKey.fromStringDer(hex);
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return PrivateKey.fromStringECDSA(hex);
  throw new Error('Unsupported private key format: expected DER hex (30…) or 32-byte ECDSA hex');
}

/** ECDSA private key → "0x" + 64 hex (the format we store and put in .env). */
export function ecdsaKeyToHex(key: PrivateKey): string {
  return `0x${key.toStringRaw()}`;
}

export function clientFor(accountId: string, key: string | PrivateKey): Client {
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), typeof key === 'string' ? parsePrivateKey(key) : key);
  return client;
}

/** SDK "0.0.X@S.NNNNNNNNN" → Mirror "0.0.X-S-NNNNNNNNN". */
export function toMirrorTxId(sdkTxId: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(sdkTxId);
  if (!m) throw new Error(`Not an SDK transaction id: ${sdkTxId}`);
  return `${m[1]}-${m[2]}-${m[3]!.padStart(9, '0')}`;
}

/** Mirror "0.0.X-S-N" → SDK "0.0.X@S.N". */
export function fromMirrorTxId(mirrorId: string): string {
  const m = /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/.exec(mirrorId);
  if (!m) throw new Error(`Not a mirror transaction id: ${mirrorId}`);
  return `${m[1]}@${m[2]}.${m[3]!.padStart(9, '0')}`;
}

/** Valid start (unix seconds, integer part) encoded in an SDK tx id. */
export function validStartSecondsOf(sdkTxId: string): number {
  const m = /@(\d+)\./.exec(sdkTxId);
  if (!m) throw new Error(`Not an SDK transaction id: ${sdkTxId}`);
  return Number(m[1]);
}

/** Build a transaction id with an explicit valid start (ms precision is plenty). */
export function txIdWithValidStart(payerAccountId: string, validStartMs: number): TransactionId {
  const seconds = Math.floor(validStartMs / 1000);
  const nanos = (validStartMs % 1000) * 1_000_000;
  return TransactionId.withValidStart(AccountId.fromString(payerAccountId), new Timestamp(seconds, nanos));
}

export const hashscan = {
  tx: (consensusTimestamp: string) => `${HASHSCAN_BASE}/transaction/${consensusTimestamp}`,
  account: (id: string) => `${HASHSCAN_BASE}/account/${id}`,
  token: (id: string) => `${HASHSCAN_BASE}/token/${id}`,
  topic: (id: string) => `${HASHSCAN_BASE}/topic/${id}`,
};

/** Display helper: smallest units → decimal string. */
export function formatUnits(amount: bigint | string, decimals: number): string {
  const v = BigInt(amount);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
```

**File: `packages/shared/src/mirror.ts`**

```ts
import { DEFAULT_MIRROR_URL } from './constants';
import { toMirrorTxId } from './hedera';

export type MirrorTransfer = { account: string; amount: number; is_approval?: boolean };
export type MirrorTokenTransfer = { token_id: string; account: string; amount: number; is_approval?: boolean };

export type MirrorTransaction = {
  transaction_id: string;
  consensus_timestamp: string;
  result: string;
  name: string;
  memo_base64: string;
  scheduled: boolean;
  nonce: number;
  valid_start_timestamp: string;
  valid_duration_seconds?: string;
  charged_tx_fee: number;
  transfers: MirrorTransfer[];
  token_transfers?: MirrorTokenTransfer[];
};

export type TxLookup =
  | { found: false }
  | { found: true; success: boolean; result: string; consensusTimestamp: string; memo: string; tx: MirrorTransaction };

export type MirrorTopicMessage = {
  consensus_timestamp: string;
  message: string; // base64
  payer_account_id: string;
  running_hash: string;
  running_hash_version: number;
  sequence_number: number;
  topic_id: string;
  chunk_info?: { number: number; total: number } | null;
};

export class Mirror {
  constructor(readonly baseUrl: string = DEFAULT_MIRROR_URL) {}

  private async get<T>(path: string): Promise<{ status: 200; body: T } | { status: 404 }> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { accept: 'application/json' } });
    if (res.status === 404) return { status: 404 };
    if (!res.ok) throw new Error(`Mirror ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
    return { status: 200, body: (await res.json()) as T };
  }

  /** Look up an SDK tx id. PAID if any non-scheduled, nonce-0 entry has result SUCCESS. */
  async getTransaction(sdkTxId: string): Promise<TxLookup> {
    const r = await this.get<{ transactions: MirrorTransaction[] }>(`/api/v1/transactions/${toMirrorTxId(sdkTxId)}`);
    if (r.status === 404 || r.body.transactions.length === 0) return { found: false };
    const parents = r.body.transactions.filter((t) => !t.scheduled && (t.nonce ?? 0) === 0);
    const list = parents.length ? parents : r.body.transactions;
    const ok = list.find((t) => t.result === 'SUCCESS');
    const t = ok ?? list[0]!;
    return {
      found: true,
      success: Boolean(ok),
      result: t.result,
      consensusTimestamp: t.consensus_timestamp,
      memo: t.memo_base64 ? Buffer.from(t.memo_base64, 'base64').toString('utf8') : '',
      tx: t,
    };
  }

  /** All topic messages with sequence_number > afterSeq, ascending, following pagination. */
  async topicMessages(topicId: string, afterSeq = 0): Promise<MirrorTopicMessage[]> {
    const out: MirrorTopicMessage[] = [];
    let path: string | null =
      `/api/v1/topics/${topicId}/messages?order=asc&limit=100&sequencenumber=gt:${afterSeq}`;
    while (path) {
      const r: { status: 200; body: { messages: MirrorTopicMessage[]; links: { next: string | null } } } | { status: 404 } =
        await this.get<{ messages: MirrorTopicMessage[]; links: { next: string | null } }>(path);
      if (r.status === 404) break;
      out.push(...r.body.messages);
      path = r.body.links?.next ?? null;
    }
    return out;
  }

  /** Recent CRYPTOTRANSFER transactions that touched an account (newest first). */
  async accountTransfers(accountId: string, limit = 100): Promise<MirrorTransaction[]> {
    const r = await this.get<{ transactions: MirrorTransaction[] }>(
      `/api/v1/transactions?account.id=${accountId}&transactiontype=CRYPTOTRANSFER&order=desc&limit=${limit}`,
    );
    return r.status === 404 ? [] : r.body.transactions;
  }

  async hbarBalance(accountId: string): Promise<bigint> {
    const r = await this.get<{ balance: { balance: number } }>(`/api/v1/accounts/${accountId}`);
    return r.status === 404 ? 0n : BigInt(r.body.balance.balance);
  }

  async tokenBalance(accountId: string, tokenId: string): Promise<bigint> {
    const r = await this.get<{ tokens: { token_id: string; balance: number }[] }>(
      `/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`,
    );
    if (r.status === 404) return 0n;
    const row = r.body.tokens.find((t) => t.token_id === tokenId);
    return row ? BigInt(row.balance) : 0n;
  }
}
```

**File: `packages/shared/test/hedera.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { formatUnits, fromMirrorTxId, parsePrivateKey, toMirrorTxId, txIdWithValidStart, validStartSecondsOf } from '../src/hedera';

describe('hedera helpers', () => {
  it('converts tx ids both ways', () => {
    expect(toMirrorTxId('0.0.7168602@1793909236.461971198')).toBe('0.0.7168602-1793909236-461971198');
    expect(toMirrorTxId('0.0.5@1700000000.5')).toBe('0.0.5-1700000000-000000005');
    expect(fromMirrorTxId('0.0.5-1700000000-000000005')).toBe('0.0.5@1700000000.000000005');
    expect(validStartSecondsOf('0.0.5@1700000000.000000005')).toBe(1700000000);
  });

  it('builds a tx id with an explicit valid start', () => {
    const id = txIdWithValidStart('0.0.42', 1_700_000_000_123);
    expect(id.toString()).toBe('0.0.42@1700000000.123000000');
  });

  it('parses a generated ECDSA hex key', () => {
    const k = parsePrivateKey('0x' + '11'.repeat(32));
    expect(k.toStringRaw()).toBe('11'.repeat(32));
  });

  it('formats units', () => {
    expect(formatUnits(50000n, 6)).toBe('0.05');
    expect(formatUnits('2000000', 6)).toBe('2');
    expect(formatUnits(0n, 6)).toBe('0');
  });
});
```

Add to `packages/shared/src/index.ts`:

```ts
export * from './hedera';
export * from './mirror';
```

**Exit checks**

- [ ] `pnpm test` → all shared tests pass (9 so far)
- [ ] Quick live check (Mirror reachable): `node -e "fetch('https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.7732679/messages?limit=1').then(r=>console.log(r.status))"` prints `200`

**Commit:** `feat(shared): hedera key/client/tx-id helpers, hashscan links, mirror node client`

---
### Phase P6 — Bootstrap Hedera: accounts, FUSD token, HCS topic

**Goal:** one script creates everything ForkOS needs on Hedera testnet and writes `deployments/testnet.json`
(public) + `.secrets/testnet-keys.json` (private). **Time:** 40 min. **Depends:** P5.

What it creates (all paid by the operator):

| Thing | How | Initial funds |
|---|---|---|
| Facilitator fee-payer account | `AccountCreateTransaction` with a new ECDSA key, `setMaxAutomaticTokenAssociations(-1)` | 100 HBAR |
| 3 provider accounts (`scribe-a`, `scribe-b`, `scribe-premium`) | same | 20 HBAR each (refund fees + REFUND messages) |
| 3 baseline-agent accounts | same | 2 HBAR + 10 FUSD each |
| **FUSD** token | `TokenCreateTransaction`, 6 decimals, 1,000,000 FUSD, treasury = operator, admin/supply key = operator | — |
| **HCS topic** | `TopicCreateTransaction`, admin key = operator, **no submit key** | — |

`setMaxAutomaticTokenAssociations(-1)` = unlimited automatic associations, so accounts receive FUSD without a
separate `TokenAssociateTransaction` (the x402 facilitator preflight accepts `-1`; verified in
`createHederaPreflightTransfer` source).

**File: `scripts/bootstrap-hedera.ts`**

```ts
// Creates accounts, the FUSD token and the referee/audit topic on Hedera testnet.
// Usage: pnpm bootstrap:hedera            (refuses to overwrite)
//        pnpm bootstrap:hedera --force
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  AccountCreateTransaction,
  Hbar,
  PrivateKey,
  TokenCreateTransaction,
  TokenSupplyType,
  TokenType,
  TopicCreateTransaction,
  TransferTransaction,
} from '@hiero-ledger/sdk';
import { clientFor, ecdsaKeyToHex, hashscan, parsePrivateKey } from '../packages/shared/src/hedera';

const must = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing ${k} in .env`);
  return v;
};

const DEPLOY = 'deployments/testnet.json';
const SECRETS = '.secrets/testnet-keys.json';
if (existsSync(DEPLOY) && !process.argv.includes('--force')) {
  throw new Error(`${DEPLOY} exists. Re-run with --force only if you really want NEW accounts/token/topic.`);
}

const operatorId = must('OPERATOR_ID');
const operatorKey = parsePrivateKey(must('OPERATOR_KEY'));
const client = clientFor(operatorId, operatorKey);

async function newAccount(label: string, hbar: number) {
  const key = PrivateKey.generateECDSA();
  const resp = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(hbar))
    .setMaxAutomaticTokenAssociations(-1)
    .execute(client);
  const receipt = await resp.getReceipt(client);
  const id = receipt.accountId!.toString();
  console.log(`  ${label.padEnd(18)} ${id}  ${hashscan.account(id)}`);
  return { id, key: ecdsaKeyToHex(key) };
}

console.log('1/4 accounts');
const facilitator = await newAccount('facilitator', 100);
const providers = {
  'scribe-a': { ...(await newAccount('scribe-a', 20)), price: '50000', name: 'Scribe A' },
  'scribe-b': { ...(await newAccount('scribe-b', 20)), price: '40000', name: 'Scribe B' },
  'scribe-premium': { ...(await newAccount('scribe-premium', 20)), price: '2000000', name: 'Scribe Premium' },
};
const baseline = [await newAccount('baseline-1', 2), await newAccount('baseline-2', 2), await newAccount('baseline-3', 2)];

console.log('2/4 FUSD token');
const tokenResp = await new TokenCreateTransaction()
  .setTokenName('ForkOS Test USD')
  .setTokenSymbol('FUSD')
  .setDecimals(6)
  .setInitialSupply(1_000_000_000_000) // 1,000,000 FUSD
  .setTreasuryAccountId(operatorId)
  .setAdminKey(operatorKey.publicKey)
  .setSupplyKey(operatorKey.publicKey)
  .setTokenType(TokenType.FungibleCommon)
  .setSupplyType(TokenSupplyType.Infinite)
  .execute(client);
const tokenId = (await tokenResp.getReceipt(client)).tokenId!.toString();
console.log(`  FUSD ${tokenId}  ${hashscan.token(tokenId)}`);

console.log('3/4 fund baseline agents with 10 FUSD each');
for (const b of baseline) {
  const r = await new TransferTransaction()
    .addTokenTransfer(tokenId, operatorId, -10_000_000)
    .addTokenTransfer(tokenId, b.id, 10_000_000)
    .execute(client);
  await r.getReceipt(client);
}

console.log('4/4 HCS topic');
const topicResp = await new TopicCreateTransaction()
  .setTopicMemo('ForkOS v1 — referee + audit log')
  .setAdminKey(operatorKey.publicKey)
  .execute(client);
const topicId = (await topicResp.getReceipt(client)).topicId!.toString();
console.log(`  topic ${topicId}  ${hashscan.topic(topicId)}`);

const deployments = {
  network: 'hedera:testnet',
  createdAt: new Date().toISOString(),
  operatorId,
  token: { id: tokenId, symbol: 'FUSD', decimals: 6 },
  topicId,
  facilitatorFeePayerId: facilitator.id,
  providers: Object.fromEntries(
    Object.entries(providers).map(([k, p]) => [k, { accountId: p.id, price: p.price, name: p.name }]),
  ),
  baselineAgents: baseline.map((b) => b.id),
};
const secrets = {
  facilitator: facilitator.key,
  providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, p.key])),
  baselineAgents: Object.fromEntries(baseline.map((b) => [b.id, b.key])),
};

mkdirSync('deployments', { recursive: true });
mkdirSync('.secrets', { recursive: true });
writeFileSync(DEPLOY, JSON.stringify(deployments, null, 2) + '\n');
writeFileSync(SECRETS, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });

console.log('\nAdd to .env:');
console.log(`PAY_ASSET=${tokenId}`);
console.log(`HCS_TOPIC_ID=${topicId}`);
console.log(`FACILITATOR_FEE_PAYER_ID=${facilitator.id}`);
console.log(`FACILITATOR_FEE_PAYER_KEY=<.secrets/testnet-keys.json → facilitator>`);
console.log('\nAdd to .env.scribe-* : PROVIDER_ACCOUNT_ID / PROVIDER_ACCOUNT_KEY from deployments + secrets');
client.close();
```

**Commands**

```bash
pnpm bootstrap:hedera
cat deployments/testnet.json
```

Then fill `.env` (`PAY_ASSET`, `HCS_TOPIC_ID`, `FACILITATOR_FEE_PAYER_ID`, `FACILITATOR_FEE_PAYER_KEY`) and the
three `.env.scribe-*` files (`PROVIDER_ACCOUNT_ID`, `PROVIDER_ACCOUNT_KEY`) from the two JSON files.

**Exit checks**

- [ ] Script prints 7 accounts, a token id and a topic id, each with a HashScan link that opens
- [ ] HashScan token page shows **FUSD**, decimals 6, total supply 1,000,000
- [ ] A baseline account page on HashScan shows **10 FUSD**
- [ ] `deployments/testnet.json` exists and contains **no** `key` fields; `.secrets/testnet-keys.json` is git-ignored (`git status` does not list it)
- [ ] Operator HBAR balance dropped by roughly 166 HBAR + fees (still > 800)

**Commit:** `feat(scripts): hedera bootstrap — accounts, FUSD token, referee topic, deployments file`

---

### Phase P7 — Shared: deployments loader

**Goal:** any service or script can read `deployments/testnet.json` without hard-coding ids.
**Time:** 10 min. **Depends:** P6.

**File: `packages/shared/src/deployments.ts`**

```ts
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
```

Add to `packages/shared/src/index.ts`:

```ts
export * from './deployments';
```

**Exit checks**

- [ ] `cd services/api && node --import tsx -e "import('@forkos/shared').then(m=>console.log(m.loadDeployments().topicId))"` prints your topic id (run `pnpm install` once first so the workspace link exists)

**Commit:** `feat(shared): deployments loader`

---

### Phase P8 — Shared: HCS message codec, publisher and follower

**Goal:** typed HCS messages exactly as ICD-5, a publisher that returns the sequence number, a Mirror Node
reader that decodes and keeps invalid messages visible, and a follower that keeps a live in-memory copy of
the topic. **Time:** 50 min. **Depends:** P5, P7.

**File: `packages/shared/src/hcs.ts`**

```ts
import { Client, TopicMessageSubmitTransaction } from '@hiero-ledger/sdk';
import { z } from 'zod';
import { MIRROR_WAIT_TIMEOUT_MS } from './constants';
import { Mirror } from './mirror';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const addr = z.string().regex(/^0x[0-9a-f]{40}$/);
const hid = z.string().regex(/^0\.0\.\d+$/);
const sdkTx = z.string().regex(/^0\.0\.\d+@\d+\.\d{9}$/);
const arkivKey = z.string().regex(/^0x[0-9a-f]{64}$/);
const round = z.number().int().nonnegative();
const units = z.string().regex(/^\d+$/);
const v = z.literal(1);

export const HcsMessage = z.discriminatedUnion('t', [
  z.object({ v, t: z.literal('LINK'), human: hex64, agent: addr, acct: hid, epoch: z.number().int().positive() }),
  z.object({ v, t: z.literal('REVOKE'), human: hex64, agent: addr, epoch: z.number().int().positive() }),
  z.object({
    v,
    t: z.literal('CLAIM'),
    job: hex64,
    round,
    human: hex64,
    agent: addr,
    epoch: z.number().int().positive(),
    svc: z.string().min(1).max(32),
    price: units,
    ak: arkivKey,
  }),
  z.object({
    v,
    t: z.literal('INTENT'),
    job: hex64,
    round,
    agent: addr,
    tx: sdkTx,
    dl: z.number().int().positive(),
    amt: units,
    asset: hid,
    payTo: hid,
  }),
  z.object({ v, t: z.literal('SETTLED'), job: hex64, round, tx: sdkTx, cts: z.string().regex(/^\d+\.\d+$/) }),
  z.object({ v, t: z.literal('VOID'), job: hex64, round, tx: z.union([sdkTx, z.literal('none')]) }),
  z.object({ v, t: z.literal('DONE'), job: hex64, round, svc: z.string().min(1).max(32), out: hex64 }),
  z.object({ v, t: z.literal('REFUND'), job: hex64, round, tx: sdkTx, rtx: sdkTx, amt: units }),
  z.object({ v, t: z.literal('APPROVAL'), human: hex64, kind: z.enum(['LINK', 'REVOKE', 'OVERCAP']), digest: hex64 }),
]);
export type HcsMessage = z.infer<typeof HcsMessage>;

export type Decoded = {
  seq: number;
  payer: string;
  cts: string;
  msg: HcsMessage | null; // null = not valid JSON or not in schema (kept so the audit can report it)
};

export function encodeHcs(msg: HcsMessage): Uint8Array {
  const parsed = HcsMessage.parse(msg);
  const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
  if (bytes.length > 1024) throw new Error(`HCS message too large (${bytes.length} bytes > 1024)`);
  return bytes;
}

export function decodeHcs(base64: string): HcsMessage | null {
  try {
    const r = HcsMessage.safeParse(JSON.parse(Buffer.from(base64, 'base64').toString('utf8')));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Submits and waits for the receipt. The submitting client's operator is the message payer. */
export async function publishHcs(
  client: Client,
  topicId: string,
  msg: HcsMessage,
): Promise<{ seq: number; txId: string }> {
  const resp = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(encodeHcs(msg)).execute(client);
  const receipt = await resp.getReceipt(client);
  const seq = receipt.topicSequenceNumber;
  if (seq == null) throw new Error('HCS receipt has no topicSequenceNumber');
  return { seq: Number(seq.toString()), txId: resp.transactionId.toString() };
}

export async function readTopic(mirror: Mirror, topicId: string, afterSeq = 0): Promise<Decoded[]> {
  const raw = await mirror.topicMessages(topicId, afterSeq);
  return raw.map((m) => ({
    seq: m.sequence_number,
    payer: m.payer_account_id,
    cts: m.consensus_timestamp,
    msg: decodeHcs(m.message),
  }));
}

/** Polls Mirror Node until a given sequence number is visible (Mirror lags consensus by a few seconds). */
export async function waitForSeq(
  mirror: Mirror,
  topicId: string,
  seq: number,
  timeoutMs = MIRROR_WAIT_TIMEOUT_MS,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const got = await mirror.topicMessages(topicId, seq - 1);
    if (got.some((m) => m.sequence_number === seq)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`HCS seq ${seq} not visible on Mirror Node after ${timeoutMs} ms`);
}

/**
 * Keeps an in-memory, ordered copy of the whole topic. Services call sync() before decisions,
 * and start() for a background poll that reports new messages.
 */
export class TopicFollower {
  readonly messages: Decoded[] = [];
  private lastSeq = 0;
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<Decoded[]> | null = null;

  constructor(
    private readonly mirror: Mirror,
    readonly topicId: string,
  ) {}

  get latestSeq(): number {
    return this.lastSeq;
  }

  /** Fetches anything new. Concurrent callers share one request. Returns only the new messages. */
  sync(): Promise<Decoded[]> {
    if (!this.syncing) {
      this.syncing = (async () => {
        try {
          const fresh = await readTopic(this.mirror, this.topicId, this.lastSeq);
          for (const d of fresh) {
            if (d.seq > this.lastSeq) {
              this.messages.push(d);
              this.lastSeq = d.seq;
            }
          }
          return fresh;
        } finally {
          this.syncing = null;
        }
      })();
    }
    return this.syncing;
  }

  /** Sync until our own message (seq) is included. */
  async syncThrough(seq: number, timeoutMs = MIRROR_WAIT_TIMEOUT_MS): Promise<void> {
    const start = Date.now();
    while (this.lastSeq < seq) {
      if (Date.now() - start > timeoutMs) throw new Error(`topic follower did not reach seq ${seq}`);
      await this.sync();
      if (this.lastSeq < seq) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  start(intervalMs: number, onNew: (fresh: Decoded[]) => void | Promise<void>): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        const fresh = await this.sync();
        if (fresh.length) await onNew(fresh);
      } catch (err) {
        console.error('[topic-follower]', (err as Error).message);
      }
    };
    void tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

**File: `packages/shared/test/hcs.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { decodeHcs, encodeHcs } from '../src/hcs';

const job = 'a'.repeat(64);
const human = 'b'.repeat(64);
const agent = '0x' + 'c'.repeat(40);

describe('hcs codec', () => {
  it('round-trips a CLAIM', () => {
    const msg = {
      v: 1 as const,
      t: 'CLAIM' as const,
      job,
      round: 0,
      human,
      agent,
      epoch: 1,
      svc: 'scribe-b',
      price: '40000',
      ak: '0x' + 'd'.repeat(64),
    };
    const b64 = Buffer.from(encodeHcs(msg)).toString('base64');
    expect(decodeHcs(b64)).toEqual(msg);
  });

  it('rejects unknown shapes and non-JSON', () => {
    expect(decodeHcs(Buffer.from('{"v":1,"t":"NOPE"}').toString('base64'))).toBeNull();
    expect(decodeHcs(Buffer.from('not json').toString('base64'))).toBeNull();
  });

  it('rejects uppercase agent addresses (we always lowercase)', () => {
    expect(() => encodeHcs({ v: 1, t: 'LINK', human, agent: '0x' + 'C'.repeat(40), acct: '0.0.5', epoch: 1 })).toThrow();
  });

  it('accepts VOID with tx "none"', () => {
    const b64 = Buffer.from(encodeHcs({ v: 1, t: 'VOID', job, round: 2, tx: 'none' })).toString('base64');
    expect(decodeHcs(b64)?.t).toBe('VOID');
  });

  it('keeps every message under 1024 bytes', () => {
    const intent = encodeHcs({
      v: 1,
      t: 'INTENT',
      job,
      round: 999,
      agent,
      tx: '0.0.1234567@1793909236.461971198',
      dl: 1793909356,
      amt: '2000000',
      asset: '0.0.5001299',
      payTo: '0.0.5001302',
    });
    expect(intent.length).toBeLessThan(1024);
  });
});
```

**File: `scripts/smoke-hcs.ts`** — publishes to a **throwaway** topic so the real topic stays clean.

```ts
import { TopicCreateTransaction } from '@hiero-ledger/sdk';
import { clientFor } from '../packages/shared/src/hedera';
import { publishHcs, readTopic, waitForSeq } from '../packages/shared/src/hcs';
import { Mirror } from '../packages/shared/src/mirror';

const client = clientFor(process.env.OPERATOR_ID!, process.env.OPERATOR_KEY!);
const mirror = new Mirror(process.env.MIRROR_URL);
const topicId = (await (await new TopicCreateTransaction().setTopicMemo('forkos smoke').execute(client)).getReceipt(client)).topicId!.toString();
console.log('throwaway topic', topicId);

const t0 = Date.now();
const { seq } = await publishHcs(client, topicId, { v: 1, t: 'APPROVAL', human: 'e'.repeat(64), kind: 'LINK', digest: 'f'.repeat(64) });
console.log('published seq', seq, 'receipt after', Date.now() - t0, 'ms');
await waitForSeq(mirror, topicId, seq);
console.log('visible on mirror after', Date.now() - t0, 'ms');
const msgs = await readTopic(mirror, topicId);
console.log('decoded:', msgs.map((m) => ({ seq: m.seq, payer: m.payer, t: m.msg?.t })));
client.close();
```

Add to `packages/shared/src/index.ts`:

```ts
export * from './hcs';
```

**Commands**

```bash
pnpm test
pnpm smoke:hcs
```

**Exit checks**

- [ ] 5 HCS codec tests pass
- [ ] `smoke:hcs` prints `published seq 1`, then `visible on mirror after N ms` (write N down; typically < 10 s. If > 30 s, raise `MIRROR_WAIT_TIMEOUT_MS`)
- [ ] Decoded output shows `payer: <OPERATOR_ID>` and `t: 'APPROVAL'` — this proves `payer_account_id` identifies the submitter

**Commit:** `feat(shared): HCS message schema, publisher, mirror reader, topic follower`

---

### Phase P9 — Shared: the referee

**Goal:** one pure function that every party (agents, API, provider, audit CLI, dashboard) uses to compute the
state of a job from the topic. Same input → same answer everywhere. **Time:** 60 min. **Depends:** P8.

Rules (these are the rules judges can audit):

1. `LINK`/`REVOKE`/`INTENT`/`SETTLED`/`VOID`/`DONE`/`APPROVAL` count only if `payer == operatorId`.
2. `REFUND` counts only if `payer` is a known provider account (when the list is given).
3. A `CLAIM` is valid iff: `round == current round`, the agent has a `LINK`, the link is active, the
   message payer equals the agent's linked Hedera account, `human` matches the link, `epoch` matches.
4. The **first valid `CLAIM` by sequence number** in the current round is the **winner**.
5. `INTENT` counts only for the current round's winner (and only the first one).
6. `SETTLED` must match the intent's tx id. `DONE` requires `SETTLED`. `REFUND` must match the settled tx.
7. `VOID` closes the round (round += 1) only if the round is not settled, and either `tx == intent.tx`, or
   `tx == "none"` and there is no intent (abandoned winner).

**File: `packages/shared/src/referee.ts`**

```ts
import type { Decoded } from './hcs';

export type LinkState = { human: string; agent: string; acct: string; epoch: number; active: boolean };

export type ClaimView = {
  seq: number;
  cts: string;
  agent: string;
  human: string;
  epoch: number;
  svc: string;
  price: string;
  arkivKey: string;
  valid: boolean;
  reason: null | 'WRONG_ROUND' | 'NOT_LINKED' | 'REVOKED' | 'PAYER_MISMATCH' | 'WRONG_HUMAN' | 'STALE_EPOCH';
};

export type IntentView = {
  seq: number;
  cts: string;
  agent: string;
  tx: string;
  deadline: number;
  amount: string;
  asset: string;
  payTo: string;
};

export type JobStatus = 'OPEN' | 'CLAIMED' | 'PAYING' | 'PAID' | 'DONE' | 'REFUNDED';

export type JobView = {
  jobKey: string;
  round: number;
  status: JobStatus;
  winner: ClaimView | null;
  claims: ClaimView[];
  intent: IntentView | null;
  settled: { seq: number; tx: string; cts: string } | null;
  done: { seq: number; svc: string; out: string } | null;
  refund: { seq: number; tx: string; rtx: string; amount: string } | null;
  history: { round: number; tx: string; seq: number }[]; // closed (VOID) rounds
  lastSeq: number;
};

export type RefereeOptions = { operatorId: string; providerAccounts?: string[] };

function freshRound() {
  return {
    winner: null as ClaimView | null,
    claims: [] as ClaimView[],
    intent: null as IntentView | null,
    settled: null as JobView['settled'],
    done: null as JobView['done'],
    refund: null as JobView['refund'],
  };
}

function applyLink(links: Map<string, LinkState>, d: Decoded, opts: RefereeOptions): boolean {
  const m = d.msg;
  if (!m || d.payer !== opts.operatorId) return false;
  if (m.t === 'LINK') {
    links.set(m.agent, { human: m.human, agent: m.agent, acct: m.acct, epoch: m.epoch, active: true });
    return true;
  }
  if (m.t === 'REVOKE') {
    const cur = links.get(m.agent);
    if (cur) links.set(m.agent, { ...cur, epoch: m.epoch, active: false });
    return true;
  }
  return false;
}

/** Link state of every agent after processing messages up to and including `uptoSeq`. */
export function buildLinks(messages: Decoded[], opts: RefereeOptions, uptoSeq = Number.POSITIVE_INFINITY) {
  const links = new Map<string, LinkState>();
  for (const d of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (d.seq > uptoSeq) break;
    applyLink(links, d, opts);
  }
  return links;
}

export function viewJob(messages: Decoded[], jobKey: string, opts: RefereeOptions): JobView {
  const links = new Map<string, LinkState>();
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  let round = 0;
  let st = freshRound();
  const history: JobView['history'] = [];
  let lastSeq = 0;
  const isOp = (d: Decoded) => d.payer === opts.operatorId;

  for (const d of sorted) {
    lastSeq = d.seq;
    if (applyLink(links, d, opts)) continue;
    const m = d.msg;
    if (!m || !('job' in m) || m.job !== jobKey) continue;

    switch (m.t) {
      case 'CLAIM': {
        const link = links.get(m.agent);
        let reason: ClaimView['reason'] = null;
        if (m.round !== round) reason = 'WRONG_ROUND';
        else if (!link) reason = 'NOT_LINKED';
        else if (!link.active) reason = 'REVOKED';
        else if (link.acct !== d.payer) reason = 'PAYER_MISMATCH';
        else if (link.human !== m.human) reason = 'WRONG_HUMAN';
        else if (link.epoch !== m.epoch) reason = 'STALE_EPOCH';
        const view: ClaimView = {
          seq: d.seq,
          cts: d.cts,
          agent: m.agent,
          human: m.human,
          epoch: m.epoch,
          svc: m.svc,
          price: m.price,
          arkivKey: m.ak,
          valid: reason === null,
          reason,
        };
        st.claims.push(view); // invalid ones too, so the dashboard and audit can show why
        if (view.valid && !st.winner) st.winner = view;
        break;
      }
      case 'INTENT': {
        if (isOp(d) && m.round === round && st.winner && m.agent === st.winner.agent && !st.intent) {
          st.intent = {
            seq: d.seq,
            cts: d.cts,
            agent: m.agent,
            tx: m.tx,
            deadline: m.dl,
            amount: m.amt,
            asset: m.asset,
            payTo: m.payTo,
          };
        }
        break;
      }
      case 'SETTLED': {
        if (isOp(d) && m.round === round && st.intent && m.tx === st.intent.tx && !st.settled) {
          st.settled = { seq: d.seq, tx: m.tx, cts: m.cts };
        }
        break;
      }
      case 'DONE': {
        if (isOp(d) && m.round === round && st.settled && !st.done) st.done = { seq: d.seq, svc: m.svc, out: m.out };
        break;
      }
      case 'REFUND': {
        const trusted = !opts.providerAccounts || opts.providerAccounts.includes(d.payer);
        if (trusted && m.round === round && st.settled && m.tx === st.settled.tx && !st.refund) {
          st.refund = { seq: d.seq, tx: m.tx, rtx: m.rtx, amount: m.amt };
        }
        break;
      }
      case 'VOID': {
        if (!isOp(d) || m.round !== round || st.settled) break;
        const closesIntent = st.intent !== null && m.tx === st.intent.tx;
        const closesAbandoned = st.intent === null && m.tx === 'none';
        if (closesIntent || closesAbandoned) {
          history.push({ round, tx: m.tx, seq: d.seq });
          round += 1;
          st = freshRound();
        }
        break;
      }
      default:
        break;
    }
  }

  const status: JobStatus = st.refund
    ? 'REFUNDED'
    : st.done
      ? 'DONE'
      : st.settled
        ? 'PAID'
        : st.intent
          ? 'PAYING'
          : st.winner
            ? 'CLAIMED'
            : 'OPEN';

  return { jobKey, round, status, ...st, history, lastSeq };
}

/** Every jobKey mentioned on the topic (for the audit CLI). */
export function jobKeysIn(messages: Decoded[]): string[] {
  const set = new Set<string>();
  for (const d of messages) if (d.msg && 'job' in d.msg) set.add(d.msg.job);
  return [...set];
}
```

**File: `packages/shared/test/referee.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { Decoded, HcsMessage } from '../src/hcs';
import { viewJob } from '../src/referee';

const OP = '0.0.100';
const PROV = '0.0.900';
const job = '1'.repeat(64);
const human = '2'.repeat(64);
const otherHuman = '3'.repeat(64);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const ak = '0x' + 'e'.repeat(64);
const TX0 = '0.0.300@1793909236.000000000';
const TX1 = '0.0.300@1793909500.000000000';

let seq = 0;
const at = (payer: string, msg: HcsMessage): Decoded => ({ seq: ++seq, payer, cts: `${1793909000 + seq}.0`, msg });
const link = (agent: string, acct: string, epoch = 1, h = human) =>
  at(OP, { v: 1, t: 'LINK', human: h, agent, acct, epoch });
const claim = (agent: string, payer: string, round = 0, epoch = 1, h = human) =>
  at(payer, { v: 1, t: 'CLAIM', job, round, human: h, agent, epoch, svc: 'scribe-a', price: '50000', ak });
const intent = (agent: string, tx: string, round = 0) =>
  at(OP, { v: 1, t: 'INTENT', job, round, agent, tx, dl: 1793909356, amt: '50000', asset: '0.0.7', payTo: '0.0.8' });
const opts = { operatorId: OP, providerAccounts: [PROV] };

describe('referee', () => {
  it('first valid claim wins; later claims lose', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), link(B, '0.0.202'), claim(B, '0.0.202'), claim(A, '0.0.201')];
    const v = viewJob(msgs, job, opts);
    expect(v.status).toBe('CLAIMED');
    expect(v.winner?.agent).toBe(B);
    expect(v.claims).toHaveLength(2);
  });

  it('rejects unlinked agents, payer mismatch, wrong human, stale epoch, revoked', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      link(B, '0.0.202', 1, otherHuman),
      claim(C, '0.0.203'), // not linked
      claim(A, '0.0.999'), // payer mismatch
      claim(B, '0.0.202'), // wrong human
      claim(A, '0.0.201', 0, 7), // stale epoch
      at(OP, { v: 1, t: 'REVOKE', human, agent: A, epoch: 2 }),
      claim(A, '0.0.201', 0, 2), // revoked
    ];
    const v = viewJob(msgs, job, opts);
    expect(v.winner).toBeNull();
    expect(v.claims.map((c) => c.reason)).toEqual(['NOT_LINKED', 'PAYER_MISMATCH', 'WRONG_HUMAN', 'STALE_EPOCH', 'REVOKED']);
    expect(v.status).toBe('OPEN');
  });

  it('ignores LINK not paid by the operator', () => {
    seq = 0;
    const fake = at('0.0.666', { v: 1, t: 'LINK', human, agent: C, acct: '0.0.203', epoch: 1 });
    const v = viewJob([fake, claim(C, '0.0.203')], job, opts);
    expect(v.winner).toBeNull();
  });

  it('INTENT → SETTLED → DONE → REFUND', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      claim(A, '0.0.201'),
      intent(A, TX0),
      at(OP, { v: 1, t: 'SETTLED', job, round: 0, tx: TX0, cts: '1793909240.1' }),
    ];
    expect(viewJob(msgs, job, opts).status).toBe('PAID');
    msgs.push(at(OP, { v: 1, t: 'DONE', job, round: 0, svc: 'scribe-a', out: 'f'.repeat(64) }));
    expect(viewJob(msgs, job, opts).status).toBe('DONE');
    msgs.push(at(PROV, { v: 1, t: 'REFUND', job, round: 0, tx: TX0, rtx: TX1, amt: '50000' }));
    expect(viewJob(msgs, job, opts).status).toBe('REFUNDED');
  });

  it('intent from a non-winner is ignored', () => {
    seq = 0;
    const msgs = [link(A, '0.0.201'), link(B, '0.0.202'), claim(A, '0.0.201'), intent(B, TX0)];
    expect(viewJob(msgs, job, opts).intent).toBeNull();
  });

  it('VOID opens the next round; old-round claims become invalid', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      link(B, '0.0.202'),
      claim(A, '0.0.201'),
      intent(A, TX0),
      at(OP, { v: 1, t: 'VOID', job, round: 0, tx: TX0 }),
      claim(A, '0.0.201', 0), // old round → WRONG_ROUND
      claim(B, '0.0.202', 1), // round 1 winner
    ];
    const v = viewJob(msgs, job, opts);
    expect(v.round).toBe(1);
    expect(v.history).toEqual([{ round: 0, tx: TX0, seq: 5 }]);
    expect(v.winner?.agent).toBe(B);
    expect(v.claims[0]!.reason).toBe('WRONG_ROUND');
  });

  it('VOID none closes an abandoned round only when there is no intent', () => {
    seq = 0;
    const abandoned = [link(A, '0.0.201'), claim(A, '0.0.201'), at(OP, { v: 1, t: 'VOID', job, round: 0, tx: 'none' })];
    expect(viewJob(abandoned, job, opts).round).toBe(1);
    seq = 0;
    const withIntent = [link(A, '0.0.201'), claim(A, '0.0.201'), intent(A, TX0), at(OP, { v: 1, t: 'VOID', job, round: 0, tx: 'none' })];
    expect(viewJob(withIntent, job, opts).round).toBe(0);
  });

  it('VOID after SETTLED is ignored (a paid round can never reopen)', () => {
    seq = 0;
    const msgs = [
      link(A, '0.0.201'),
      claim(A, '0.0.201'),
      intent(A, TX0),
      at(OP, { v: 1, t: 'SETTLED', job, round: 0, tx: TX0, cts: '1.1' }),
      at(OP, { v: 1, t: 'VOID', job, round: 0, tx: TX0 }),
    ];
    const v = viewJob(msgs, job, opts);
    expect(v.round).toBe(0);
    expect(v.status).toBe('PAID');
  });
});
```

Add to `packages/shared/src/index.ts`:

```ts
export * from './referee';
```

**Exit checks**

- [ ] 8 referee tests pass
- [ ] `pnpm typecheck` passes

**Commit:** `feat(shared): HCS referee — first valid claim wins, rounds close only on proven VOID`

---

### Phase P10 — Shared: Arkiv schemas and client

**Goal:** the three schemas from ICD-6, typed public/wallet clients for Rabdi, read helpers that return plain
objects, and a smoke test that proves short-lived entities expire on time. **Time:** 50 min. **Depends:** P2.

**File: `packages/shared/src/arkiv.ts`**

```ts
import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq } from '@arkiv-network/sdk/query';
import { defineSchema, key, str, u64 } from '@arkiv-network/sdk/schema';
import { http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CAPABILITY, SCHEMA_AGENTLINK, SCHEMA_CLAIM, SCHEMA_SERVICE } from './constants';

export { ExpirationTime, and, eq, u64 };

export const ServiceSchema = defineSchema(SCHEMA_SERVICE, {
  providerId: str().indexed(),
  capability: str().indexed(),
  network: str().indexed(),
  asset: str().indexed(),
  price: u64().indexed(),
  name: str(),
  endpoint: str(),
  payTo: str(),
});

export const AgentLinkSchema = defineSchema(SCHEMA_AGENTLINK, {
  human: str().indexed(),
  agent: str().indexed(),
  status: str().indexed(),
  epoch: u64().indexed(),
  acct: str(),
  label: str(),
});

export const ClaimSchema = defineSchema(SCHEMA_CLAIM, {
  job: str().indexed(),
  round: u64().indexed(),
  human: str().indexed(),
  agent: str().indexed(),
  status: str().indexed(),
  epoch: u64(),
  svc: str(),
  price: u64(),
  seq: u64(),
  tx: str(),
});

export function arkivPublic(accessKey: string) {
  return createPublicClient({ chain: rabdi({ accessKey }), transport: http() });
}

export function arkivWallet(accessKey: string, privateKey: `0x${string}`) {
  return createWalletClient({ chain: rabdi({ accessKey }), transport: http(), account: privateKeyToAccount(privateKey) });
}

export type ArkivPublic = ReturnType<typeof arkivPublic>;
export type ArkivWallet = ReturnType<typeof arkivWallet>;

/** Arkiv typed values come back as { type, value }; normalize to plain JS. */
const s = (v: { value: unknown } | undefined) => String(v?.value ?? '');
const n = (v: { value: unknown } | undefined) => BigInt((v?.value as bigint | number | string | undefined) ?? 0);

export type ServiceRow = {
  key: string;
  owner: string;
  expiresAt: bigint;
  providerId: string;
  capability: string;
  network: string;
  asset: string;
  price: bigint;
  name: string;
  endpoint: string;
  payTo: string;
};

export async function listServices(pub: ArkivPublic, capability = CAPABILITY): Promise<ServiceRow[]> {
  const res = await pub
    .select({
      $key: true,
      $owner: true,
      $expiresAt: true,
      providerId: true,
      capability: true,
      network: true,
      asset: true,
      price: true,
      name: true,
      endpoint: true,
      payTo: true,
    })
    .from(ServiceSchema)
    .where(eq('capability', capability))
    .limit(100)
    .fetch();
  return res.entities.map((e) => ({
    key: String(e.$key),
    owner: String(e.$owner).toLowerCase(),
    expiresAt: BigInt(e.$expiresAt),
    providerId: s(e.providerId),
    capability: s(e.capability),
    network: s(e.network),
    asset: s(e.asset),
    price: n(e.price),
    name: s(e.name),
    endpoint: s(e.endpoint),
    payTo: s(e.payTo),
  }));
}

export type AgentLinkRow = {
  key: string;
  owner: string;
  human: string;
  agent: string;
  status: string;
  epoch: number;
  acct: string;
  label: string;
};

export async function getAgentLink(pub: ArkivPublic, agent: string, owner: string): Promise<AgentLinkRow | null> {
  const res = await pub
    .select({ $key: true, $owner: true, human: true, agent: true, status: true, epoch: true, acct: true, label: true })
    .from(AgentLinkSchema)
    .where(eq('agent', agent.toLowerCase()))
    .ownedBy(owner as `0x${string}`)
    .limit(10)
    .fetch();
  const e = res.entities[0];
  if (!e) return null;
  return {
    key: String(e.$key),
    owner: String(e.$owner).toLowerCase(),
    human: s(e.human),
    agent: s(e.agent),
    status: s(e.status),
    epoch: Number(n(e.epoch)),
    acct: s(e.acct),
    label: s(e.label),
  };
}

export type ClaimRow = {
  key: string;
  owner: string;
  expiresAt: bigint;
  job: string;
  round: number;
  human: string;
  agent: string;
  status: string;
  epoch: number;
  svc: string;
  price: bigint;
  seq: number;
  tx: string;
};

const CLAIM_FIELDS = {
  $key: true,
  $owner: true,
  $expiresAt: true,
  job: true,
  round: true,
  human: true,
  agent: true,
  status: true,
  epoch: true,
  svc: true,
  price: true,
  seq: true,
  tx: true,
} as const;

function toClaim(e: Record<string, any>): ClaimRow {
  return {
    key: String(e.$key),
    owner: String(e.$owner).toLowerCase(),
    expiresAt: BigInt(e.$expiresAt),
    job: s(e.job),
    round: Number(n(e.round)),
    human: s(e.human),
    agent: s(e.agent),
    status: s(e.status),
    epoch: Number(n(e.epoch)),
    svc: s(e.svc),
    price: n(e.price),
    seq: Number(n(e.seq)),
    tx: s(e.tx),
  };
}

export async function listClaims(pub: ArkivPublic, job: string): Promise<ClaimRow[]> {
  const res = await pub.select(CLAIM_FIELDS).from(ClaimSchema).where(eq('job', job)).limit(100).fetch();
  return res.entities.map((e) => toClaim(e as Record<string, any>));
}

export async function getClaim(pub: ArkivPublic, entityKey: string): Promise<ClaimRow | null> {
  const res = await pub
    .select(CLAIM_FIELDS)
    .from(ClaimSchema)
    .where(eq('$key', key(entityKey as `0x${string}`))) // key() typed value, as in the SDK README paging example
    .limit(1)
    .fetch();
  const e = res.entities[0];
  return e ? toClaim(e as Record<string, any>) : null;
}

/** Seconds per block on Arkiv is 2; lifetimes must be even. */
export function evenSeconds(seconds: number): number {
  const s2 = Math.ceil(seconds);
  return s2 % 2 === 0 ? s2 : s2 + 1;
}
```

> **Note on `eq('$key', key(…))`:** the SDK README filters on `$key` with the `key(...)` typed value
> (`gt("$key", key(lastKey))`). If your build rejects it, use `pub.getEntity(entityKey, ClaimSchema)` instead
> (also in the README) and map the result with `toClaim` — the exit check below tells you which works.

**File: `scripts/smoke-arkiv.ts`**

```ts
// Proves: write as a wallet, read back through a query, expiry roughly on time.
import { arkivPublic, arkivWallet, ExpirationTime, getClaim, listClaims, ClaimSchema, u64 } from '../packages/shared/src/arkiv';

const accessKey = process.env.ARKIV_ACCESS_KEY!;
const key = process.env.FORKOS_AGENT_KEY as `0x${string}`; // any funded wallet; the agent key is fine
const pub = arkivPublic(accessKey);
const wallet = arkivWallet(accessKey, key);

const job = 'ab'.repeat(32);
const t0 = Date.now();
const created = await wallet.createEntity(
  ClaimSchema,
  {
    job,
    round: u64(0),
    human: 'cd'.repeat(32),
    agent: wallet.account.address.toLowerCase(),
    status: 'OPEN',
    epoch: u64(1),
    svc: 'smoke',
    price: u64(1),
    seq: u64(0),
    tx: '-',
  },
  { expiration: ExpirationTime.fromSeconds(30) },
);
console.log('created', created.entityKey, 'tx', created.txHash, 'expiresAt block', created.expiresAt, 'in', Date.now() - t0, 'ms');

console.log('by job:', (await listClaims(pub, job)).map((c) => ({ key: c.key, status: c.status, owner: c.owner })));
console.log('by key:', (await getClaim(pub, created.entityKey))?.status);

await wallet.patchEntity(ClaimSchema, created.entityKey, { set: { status: 'WON' } });
console.log('after patch:', (await getClaim(pub, created.entityKey))?.status);

console.log('waiting 40 s for expiry…');
await new Promise((r) => setTimeout(r, 40_000));
console.log('after expiry (expect 0):', (await listClaims(pub, job)).length);
```

**File: `packages/shared/src/index.ts`** (final version — replace the whole file)

```ts
export * from './constants';
export * from './env';
export * from './errors';
export * from './hash';
export * from './ids';
export * from './hedera';
export * from './mirror';
export * from './deployments';
export * from './hcs';
export * from './referee';
export * from './arkiv';
```

**Commands**

```bash
# fund FORKOS_AGENT_KEY's address with tGLM first (hub.arkiv.network/faucet)
pnpm smoke:arkiv
```

**Exit checks**

- [ ] `created 0x… expiresAt block …` printed (write time < ~5 s)
- [ ] `by job` lists 1 claim with `owner` = your agent address; `by key: OPEN`; `after patch: WON`
- [ ] `after expiry (expect 0): 0`
- [ ] The entity is visible on `https://rabdi.explorer.arkiv.network` while it lives
- [ ] Write in `arkiv/friction.md` (create the file) anything that surprised you — this is 25 % of Arkiv's judging

**Commit:** `feat(shared): arkiv schemas (service, agentlink, claim), typed readers, expiry smoke test`

---
### Phase P11 — Database schema and migration runner

**Goal:** every table in ICD-13, created by an idempotent migration runner. **Time:** 30 min. **Depends:** P1.

**File: `migrations/001_init.sql`**

```sql
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
```

**File: `scripts/migrate.ts`**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');
const sql = postgres(url, { max: 1 });

await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
const dir = 'migrations';
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(file)) {
    console.log('skip', file);
    continue;
  }
  const text = readFileSync(join(dir, file), 'utf8');
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`insert into schema_migrations (name) values (${file})`;
  });
  console.log('applied', file);
}
await sql.end();
```

**Commands**

```bash
pnpm db:migrate
pnpm db:migrate     # second run must only print "skip"
docker compose exec db psql -U forkos -c '\dt'
```

**Exit checks**

- [ ] First run prints `applied 001_init.sql`, second prints `skip 001_init.sql`
- [ ] `\dt` lists 12 tables + `schema_migrations`

**Commit:** `feat(db): schema v1 for facilitator, provider and api + migration runner`

---

### Phase P12 — Facilitator: the x402 contract on Hedera

**Goal:** our own facilitator exposing `GET /supported`, `POST /verify`, `POST /settle`, built on the
reference `@x402/hedera` facilitator scheme (all spec MUST-checks: layout, fee-payer safety, exact amount,
payer signature against the on-chain key, balance/association preflight). **Time:** 45 min. **Depends:** P5, P11.

**File: `services/facilitator/src/env.ts`**

```ts
import { DEFAULT_MIRROR_URL, loadEnv, zHederaId } from '@forkos/shared';
import { z } from 'zod';

export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  FACILITATOR_FEE_PAYER_ID: zHederaId,
  FACILITATOR_FEE_PAYER_KEY: z.string().min(10),
  MIRROR_URL: z.string().url().default(DEFAULT_MIRROR_URL),
});
```

**File: `services/facilitator/src/facilitator.ts`**

```ts
import { parsePrivateKey, NETWORK } from '@forkos/shared';
import { x402Facilitator } from '@x402/core/facilitator';
import {
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  createHederaVerifyPayerSignature,
  toFacilitatorHederaSigner,
} from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/facilitator';
import { env } from './env';
import { intentWindowProblem } from './guards';

const feePayerKey = parsePrivateKey(env.FACILITATOR_FEE_PAYER_KEY);

const signer = toFacilitatorHederaSigner({
  getAddresses: () => [env.FACILITATOR_FEE_PAYER_ID],
  // Adds our fee-payer signature, submits, and waits for a SUCCESS receipt (throws otherwise).
  signAndSubmitTransaction: createHederaSignAndSubmitTransaction((network) => createHederaClient(network), feePayerKey),
  // Checks the payer really signed, against the payer's on-chain key from Mirror Node.
  verifyPayerSignature: createHederaVerifyPayerSignature({ mirrorNodeUrl: env.MIRROR_URL }),
  // Checks payer balance and payTo association / auto-association capacity.
  preflightTransfer: createHederaPreflightTransfer({ mirrorNodeUrl: env.MIRROR_URL }),
});

export const facilitator = new x402Facilitator().register(
  NETWORK,
  new ExactHederaScheme(signer, { aliasPolicy: 'reject' }),
);

// ForkOS extra check #1 (verify time): refuse intents that are expired, about to expire, or longer-lived than 120 s.
facilitator.onBeforeVerify(async ({ paymentPayload }) => {
  const problem = intentWindowProblem(paymentPayload);
  if (problem) return { abort: true, reason: problem };
});
```

**File: `services/facilitator/src/guards.ts`** (window check now; replay check is added in P13)

```ts
import { VALID_DURATION_S } from '@forkos/shared';
import { Transaction } from '@hiero-ledger/sdk';
import type { PaymentPayload } from '@x402/core/types';
import { extractTransactionFromPayload } from '@x402/hedera';

export type DecodedIntent = { txId: string; validStartMs: number; durationS: number; memo: string };

export function decodeIntent(paymentPayload: PaymentPayload): DecodedIntent {
  const b64 = extractTransactionFromPayload(paymentPayload.payload as { transaction: string });
  const tx = Transaction.fromBytes(Buffer.from(b64, 'base64'));
  const id = tx.transactionId;
  if (!id || !id.validStart) throw new Error('transaction has no transaction id / valid start');
  const validStartMs = Number(id.validStart.seconds.toString()) * 1000 + Math.floor(Number(id.validStart.nanos.toString()) / 1e6);
  return { txId: id.toString(), validStartMs, durationS: tx.transactionValidDuration, memo: tx.transactionMemo };
}

/** Returns an invalid-reason string, or null when the intent window is fine. */
export function intentWindowProblem(paymentPayload: PaymentPayload, nowMs = Date.now()): string | null {
  let d: DecodedIntent;
  try {
    d = decodeIntent(paymentPayload);
  } catch {
    return 'forkos_undecodable_transaction';
  }
  if (d.durationS > VALID_DURATION_S) return 'forkos_valid_duration_too_long';
  const deadlineMs = d.validStartMs + d.durationS * 1000;
  if (nowMs > deadlineMs - 2_000) return 'forkos_intent_expired';
  if (d.validStartMs > nowMs + 10_000) return 'forkos_valid_start_in_future';
  return null;
}
```

**File: `services/facilitator/src/db.ts`**

```ts
import postgres from 'postgres';
import { env } from './env';

export const sql = postgres(env.DATABASE_URL, { max: 5 });
```

**File: `services/facilitator/src/index.ts`**

```ts
import { NETWORK, portFrom } from '@forkos/shared';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import Fastify from 'fastify';
import { sql } from './db';
import { facilitator } from './facilitator';
import { settleOnce } from './settle';

const app = Fastify({ logger: { level: 'info' } });

type Body = { x402Version: number; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };

app.get('/health', async () => ({ ok: true, network: NETWORK, supported: facilitator.getSupported() }));

app.get('/supported', async () => facilitator.getSupported());

app.post<{ Body: Body }>('/verify', async (req) => {
  const { paymentPayload, paymentRequirements } = req.body;
  try {
    return await facilitator.verify(paymentPayload, paymentRequirements);
  } catch (err) {
    req.log.error({ err }, 'verify crashed');
    return { isValid: false, invalidReason: 'forkos_verify_error', invalidMessage: (err as Error).message };
  }
});

app.post<{ Body: Body }>('/settle', async (req) => {
  const { paymentPayload, paymentRequirements } = req.body;
  return settleOnce(paymentPayload, paymentRequirements, req.log);
});

app.get<{ Params: { txId: string } }>('/v1/settlements/:txId', async (req, reply) => {
  const [row] = await sql`select tx_id, status, attempts, last_error, updated_at from fac_settlements where tx_id = ${req.params.txId}`;
  if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'unknown tx' } });
  return row;
});

const port = portFrom('FACILITATOR_PORT', 4020);
await app.listen({ host: '0.0.0.0', port });
```

**File: `services/facilitator/src/settle.ts`** (P12 version: no replay table yet; P13 replaces this file)

```ts
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { FastifyBaseLogger } from 'fastify';
import { facilitator } from './facilitator';

export async function settleOnce(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  log: FastifyBaseLogger,
): Promise<SettleResponse> {
  try {
    return await facilitator.settle(paymentPayload, requirements);
  } catch (err) {
    log.error({ err }, 'settle crashed');
    return {
      success: false,
      errorReason: 'forkos_settle_error',
      errorMessage: (err as Error).message,
      transaction: '',
      network: requirements.network,
    };
  }
}
```

**Commands**

```bash
pnpm dev:facilitator
curl -s localhost:4020/supported
```

**Exit checks**

- [ ] Facilitator boots on `:4020` without env errors
- [ ] `/supported` returns `kinds:[{x402Version:2, scheme:"exact", network:"hedera:testnet", extra:{feePayer:"<FACILITATOR_FEE_PAYER_ID>"}}]` and `signers` listing the fee payer
- [ ] `curl -s -XPOST localhost:4020/verify -H 'content-type: application/json' -d '{"x402Version":2,"paymentPayload":{"x402Version":2,"accepted":{},"payload":{"transaction":"AA=="}},"paymentRequirements":{"scheme":"exact","network":"hedera:testnet","asset":"0.0.1","amount":"1","payTo":"0.0.2","maxTimeoutSeconds":60,"extra":{}}}'` returns `200` with `isValid:false` (not a crash)

**Commit:** `feat(facilitator): x402 facilitator for hedera:testnet on the reference exact scheme + intent window guard`

---

### Phase P13 — Facilitator: replay table (exactly-once at our door)

**Goal:** a settlement for a given transaction id is attempted at most once while it is in flight or after it
succeeded. The reference facilitator relies only on network dedupe (verified in its source); ours adds an
explicit, persistent replay table — this is the "facilitator with its own safety checks and replay
protection" from Hedera's idea list. **Time:** 35 min. **Depends:** P12.

Rule:

```text
INSERT tx_id → SETTLING           (first attempt)
conflict and status = FAILED      → allowed again (attempts+1)    network dedupe still protects
conflict and status SETTLING      → reject  forkos_replay_detected (in flight)
conflict and status SETTLED       → reject  forkos_replay_detected (already paid)
```

**File: `services/facilitator/src/settle.ts`** (replaces the P12 version)

```ts
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from './db';
import { facilitator } from './facilitator';
import { decodeIntent, intentWindowProblem } from './guards';

function fail(requirements: PaymentRequirements, reason: string, message: string, tx = ''): SettleResponse {
  return { success: false, errorReason: reason, errorMessage: message, transaction: tx, network: requirements.network };
}

export async function settleOnce(
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  log: FastifyBaseLogger,
): Promise<SettleResponse> {
  let txId: string;
  try {
    txId = decodeIntent(paymentPayload).txId;
  } catch (err) {
    return fail(requirements, 'forkos_undecodable_transaction', (err as Error).message);
  }

  const windowProblem = intentWindowProblem(paymentPayload);
  if (windowProblem) return fail(requirements, windowProblem, 'intent outside its validity window', txId);

  // Claim the tx id. Returns a row only if we may attempt settlement now.
  const claimed = await sql<{ status: string; attempts: number }[]>`
    insert into fac_settlements (tx_id, status, pay_to, asset, amount)
    values (${txId}, 'SETTLING', ${requirements.payTo}, ${requirements.asset}, ${requirements.amount})
    on conflict (tx_id) do update
      set status = 'SETTLING', attempts = fac_settlements.attempts + 1, updated_at = now()
      where fac_settlements.status = 'FAILED'
    returning status, attempts`;
  if (claimed.length === 0) {
    const [existing] = await sql<{ status: string }[]>`select status from fac_settlements where tx_id = ${txId}`;
    log.warn({ txId, status: existing?.status }, 'replay rejected');
    return fail(requirements, 'forkos_replay_detected', `transaction already ${existing?.status ?? 'seen'}`, txId);
  }

  let result: SettleResponse;
  try {
    result = await facilitator.settle(paymentPayload, requirements);
  } catch (err) {
    result = fail(requirements, 'forkos_settle_error', (err as Error).message, txId);
  }

  await sql`
    update fac_settlements
       set status = ${result.success ? 'SETTLED' : 'FAILED'},
           last_error = ${result.success ? null : `${result.errorReason ?? ''} ${result.errorMessage ?? ''}`.trim()},
           settle_tx = ${result.transaction || null},
           updated_at = now()
     where tx_id = ${txId}`;
  log.info({ txId, success: result.success, reason: result.errorReason }, 'settle finished');
  return result;
}
```

**File: `services/facilitator/test/guards.test.ts`**

```ts
import { PrivateKey, TransferTransaction } from '@hiero-ledger/sdk';
import { Client } from '@hiero-ledger/sdk';
import { describe, expect, it } from 'vitest';
import { txIdWithValidStart } from '@forkos/shared';
import { decodeIntent, intentWindowProblem } from '../src/guards';

function payloadFor(validStartMs: number, duration = 120) {
  const tx = new TransferTransaction()
    .addHbarTransfer('0.0.1001', -5)
    .addHbarTransfer('0.0.1002', 5)
    .setTransactionId(txIdWithValidStart('0.0.900', validStartMs))
    .setTransactionValidDuration(duration)
    .setTransactionMemo('forkos:0123456789abcdef:r0');
  const client = Client.forTestnet();
  tx.freezeWith(client);
  client.close();
  const b64 = Buffer.from(tx.toBytes()).toString('base64');
  return { x402Version: 2, accepted: {} as never, payload: { transaction: b64 } };
}

describe('facilitator guards', () => {
  it('decodes tx id, valid start, duration and memo', () => {
    const now = 1_793_909_236_000;
    const d = decodeIntent(payloadFor(now));
    expect(d.txId).toBe('0.0.900@1793909236.000000000');
    expect(d.validStartMs).toBe(now);
    expect(d.durationS).toBe(120);
    expect(d.memo).toBe('forkos:0123456789abcdef:r0');
  });

  it('accepts a fresh intent, rejects expired / too long / future', () => {
    const now = Date.now();
    expect(intentWindowProblem(payloadFor(now - 5_000), now)).toBeNull();
    expect(intentWindowProblem(payloadFor(now - 119_000), now)).toBe('forkos_intent_expired');
    expect(intentWindowProblem(payloadFor(now - 5_000, 180), now)).toBe('forkos_valid_duration_too_long');
    expect(intentWindowProblem(payloadFor(now + 60_000), now)).toBe('forkos_valid_start_in_future');
    expect(intentWindowProblem({ x402Version: 2, accepted: {} as never, payload: { transaction: 'AA==' } }, now)).toBe(
      'forkos_undecodable_transaction',
    );
  });
});
```

> The test never touches the network: `Client.forTestnet()` is only used to pick node ids for `freezeWith`.
> Add `@forkos/shared` and `@hiero-ledger/sdk` resolution for tests: the root `vitest.config.ts` already
> includes `services/*/test/**`. Run `pnpm --filter @forkos/facilitator add -D vitest@^3.2.0` if your editor
> complains about the import.

**Commands**

```bash
pnpm test
pnpm dev:facilitator
```

**Exit checks**

- [ ] Guard tests pass (2 tests)
- [ ] Facilitator still boots; `/v1/settlements/0.0.1@1.000000000` returns `404`

**Commit:** `feat(facilitator): persistent replay table — one settlement attempt per tx id while in flight or settled`

---

### Phase P14 — `@forkos/x402-hedera`: payment intents with a death clock

**Goal:** the publishable package. A drop-in `ClientHederaSigner` for the official x402 client that builds the
transfer with **our own transaction id**, a **120 s validity**, and a **memo**, and **persists the signed bytes
before they are returned** (i.e. before anything is sent). Plus a helper to build the full x402
`PaymentPayload`. **Time:** 60 min. **Depends:** P5.

> **Gotcha (verified in `@x402/core` source):** `x402Client` applies **spend controls by default**: it rejects
> every asset that is not a built-in default (our FUSD would be refused) and caps payments at `$1`. ForkOS has
> its own policy engine (P28), so we call `client.setSpendControls(false)`. Without this line every FUSD payment
> fails with "All payment requirements were rejected by spendControls".

**File: `packages/x402-hedera/src/intent.ts`**

```ts
import { RESEND_CUTOFF_S, VALID_DURATION_S, VALID_START_BACKDATE_S, parsePrivateKey, txIdWithValidStart } from '@forkos/shared';
import { AccountId, Client, Hbar, PrivateKey, TokenId, TransferTransaction } from '@hiero-ledger/sdk';
import type { PaymentRequirements } from '@x402/core/types';
import type { ClientHederaSigner } from '@x402/hedera';

export type PaymentIntent = {
  txId: string; // SDK format, known before sending
  validStartMs: number;
  deadlineS: number; // unix seconds: the transaction is dead after this
  memo: string;
  transactionBase64: string; // signed by the payer, not yet by the fee payer
  requirements: PaymentRequirements;
};

export type IntentSignerOptions = {
  /** Paying account (holds the asset). */
  accountId: string;
  privateKey: PrivateKey | string;
  /** Written into the transaction memo (≤ 100 bytes). Use memoOf(jobKey, round). */
  memo: string;
  /**
   * Called with the fully built intent BEFORE the bytes are handed back to x402 (= before sending).
   * Persist it durably here. If this throws, nothing is sent.
   */
  persist: (intent: PaymentIntent) => Promise<void>;
  nowMs?: () => number;
};

export function deadlineOf(validStartMs: number): number {
  return Math.ceil((validStartMs + VALID_DURATION_S * 1000) / 1000);
}

/** True while it is still safe to resend the SAME bytes (never re-sign). */
export function canResend(deadlineS: number, nowMs = Date.now()): boolean {
  return nowMs / 1000 < deadlineS - RESEND_CUTOFF_S;
}

export function createIntentSigner(opts: IntentSignerOptions): ClientHederaSigner {
  const payer = AccountId.fromString(opts.accountId);
  const key = typeof opts.privateKey === 'string' ? parsePrivateKey(opts.privateKey) : opts.privateKey;
  if (Buffer.byteLength(opts.memo) > 100) throw new Error('memo exceeds 100 bytes');
  const now = opts.nowMs ?? Date.now;

  return {
    accountId: payer.toString(),
    async createPartiallySignedTransferTransaction(requirements: PaymentRequirements): Promise<string> {
      if (requirements.network !== 'hedera:testnet' && requirements.network !== 'hedera:mainnet') {
        throw new Error(`unsupported network ${requirements.network}`);
      }
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== 'string') throw new Error('feePayer missing in requirements.extra');
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error('amount must be > 0');
      const payTo = AccountId.fromString(requirements.payTo);

      const tx = new TransferTransaction();
      if (requirements.asset === '0.0.0') {
        tx.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
        tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const tokenId = TokenId.fromString(requirements.asset);
        tx.addTokenTransfer(tokenId, payer, -amount);
        tx.addTokenTransfer(tokenId, payTo, amount);
      }

      // The death clock: our own id (payer = facilitator fee payer, as the spec requires), explicit validity.
      const validStartMs = now() - VALID_START_BACKDATE_S * 1000;
      const txId = txIdWithValidStart(feePayer, validStartMs);
      tx.setTransactionId(txId);
      tx.setTransactionValidDuration(VALID_DURATION_S);
      tx.setTransactionMemo(opts.memo);

      const client = requirements.network === 'hedera:mainnet' ? Client.forMainnet() : Client.forTestnet();
      try {
        tx.freezeWith(client); // picks node account ids; no network call
        const signed = await tx.sign(key);
        const transactionBase64 = Buffer.from(signed.toBytes()).toString('base64');
        const intent: PaymentIntent = {
          txId: txId.toString(),
          validStartMs,
          deadlineS: deadlineOf(validStartMs),
          memo: opts.memo,
          transactionBase64,
          requirements,
        };
        await opts.persist(intent); // BEFORE returning → before x402 sends anything
        return transactionBase64;
      } finally {
        client.close();
      }
    },
  };
}
```

**File: `packages/x402-hedera/src/payload.ts`**

```ts
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createIntentSigner, type IntentSignerOptions, type PaymentIntent } from './intent';

export type BuiltPayment = { payload: PaymentPayload; intent: PaymentIntent };

/**
 * Builds the x402 PaymentPayload for `chosen` using the official x402 client + our intent signer.
 * The intent is persisted (opts.persist) before this resolves.
 */
export async function buildIntentPayment(
  paymentRequired: PaymentRequired,
  chosen: PaymentRequirements,
  opts: Omit<IntentSignerOptions, 'persist'> & { persist: (i: PaymentIntent) => Promise<void> },
): Promise<BuiltPayment> {
  let captured: PaymentIntent | null = null;
  const signer = createIntentSigner({
    ...opts,
    persist: async (i) => {
      captured = i;
      await opts.persist(i);
    },
  });
  const client = new x402Client((_v, accepts) => {
    const match = accepts.find(
      (a) =>
        a.scheme === chosen.scheme &&
        a.network === chosen.network &&
        a.asset === chosen.asset &&
        a.amount === chosen.amount &&
        a.payTo === chosen.payTo,
    );
    if (!match) throw new Error('chosen payment requirement not offered by the server');
    return match;
  })
    .register('hedera:*', new ExactHederaScheme(signer))
    .setSpendControls(false); // ForkOS policy (P28) enforces limits; see gotcha above

  const payload = await client.createPaymentPayload(paymentRequired);
  if (!captured) throw new Error('intent was not persisted');
  return { payload, intent: captured };
}

/** Picks the requirement for our network + asset (cheapest if several). */
export function pickRequirement(paymentRequired: PaymentRequired, network: string, asset: string): PaymentRequirements {
  const options = paymentRequired.accepts
    .filter((a) => a.scheme === 'exact' && a.network === network && a.asset === asset)
    .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  const first = options[0];
  if (!first) throw new Error(`server offers no exact ${network} option in asset ${asset}`);
  return first;
}
```

**File: `packages/x402-hedera/src/index.ts`**

```ts
export * from './intent';
export * from './payload';
```

**File: `packages/x402-hedera/test/intent.test.ts`**

```ts
import { PrivateKey } from '@hiero-ledger/sdk';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { inspectHederaTransaction } from '@x402/hedera';
import { describe, expect, it } from 'vitest';
import { buildIntentPayment, canResend, createIntentSigner, type PaymentIntent } from '../src';

const key = PrivateKey.generateECDSA();
const req: PaymentRequirements = {
  scheme: 'exact',
  network: 'hedera:testnet',
  asset: '0.0.5001299',
  amount: '50000',
  payTo: '0.0.5001302',
  maxTimeoutSeconds: 180,
  extra: { feePayer: '0.0.5001300' },
};
const NOW = 1_793_909_236_000;

describe('intent signer', () => {
  it('builds a facilitator-valid transfer with our id, 120 s validity and memo, persisting first', async () => {
    const order: string[] = [];
    let saved: PaymentIntent | null = null;
    const signer = createIntentSigner({
      accountId: '0.0.5001305',
      privateKey: key,
      memo: 'forkos:11f22571df7398b5:r0',
      nowMs: () => NOW,
      persist: async (i) => {
        order.push('persist');
        saved = i;
      },
    });
    const b64 = await signer.createPartiallySignedTransferTransaction(req);
    order.push('returned');
    expect(order).toEqual(['persist', 'returned']);
    expect(saved!.txId).toBe('0.0.5001300@1793909231.000000000'); // NOW - 5 s, payer = fee payer
    expect(saved!.deadlineS).toBe(1793909231 + 120);
    expect(saved!.transactionBase64).toBe(b64);

    // Same inspection the reference facilitator runs in verify():
    // (transactionType is the SDK class name, minified in the SDK build — the facilitator only checks it is a string)
    const inspected = inspectHederaTransaction(b64);
    expect(inspected.transactionIdAccountId).toBe('0.0.5001300');
    expect(inspected.hasNonTransferOperations).toBe(false);
    const transfers = inspected.tokenTransfers['0.0.5001299']!;
    expect(transfers).toEqual(
      expect.arrayContaining([
        { accountId: '0.0.5001305', amount: '-50000' },
        { accountId: '0.0.5001302', amount: '50000' },
      ]),
    );
  });

  it('nothing is returned if persisting fails', async () => {
    const signer = createIntentSigner({
      accountId: '0.0.5001305',
      privateKey: key,
      memo: 'm',
      persist: async () => {
        throw new Error('db down');
      },
    });
    await expect(signer.createPartiallySignedTransferTransaction(req)).rejects.toThrow('db down');
  });

  it('builds a full x402 PaymentPayload through the official client (FUSD not blocked)', async () => {
    const pr: PaymentRequired = { x402Version: 2, resource: { url: 'http://x/v1/jobs' }, accepts: [req] };
    const built = await buildIntentPayment(pr, req, {
      accountId: '0.0.5001305',
      privateKey: key,
      memo: 'forkos:11f22571df7398b5:r0',
      persist: async () => {},
    });
    expect(built.payload.x402Version).toBe(2);
    expect(built.payload.accepted).toEqual(req);
    expect((built.payload.payload as { transaction: string }).transaction).toBe(built.intent.transactionBase64);
  });

  it('resend window closes 10 s before the deadline', () => {
    expect(canResend(1000, 989_000)).toBe(true);
    expect(canResend(1000, 990_500)).toBe(false);
  });
});
```

**Exit checks**

- [ ] 4 intent tests pass — in particular the official `inspectHederaTransaction` sees our tx id payer = fee
      payer and a clean two-leg token transfer (that is exactly what facilitator `verify` checks)
- [ ] The third test passes → spend-controls gotcha handled

**Commit:** `feat(x402-hedera): payment intents — own tx id, 120 s death clock, persisted before send`

---

### Phase P15 — Resolver + first real payments (the proof)

**Goal:** the resolver that turns "unknown" into PAID / FAILED / VOID, and a smoke script that proves on
testnet: (1) an intent settles through our facilitator in FUSD, (2) a replay is rejected by our facilitator,
(3) a direct resubmission is rejected by **the network** with `DUPLICATE_TRANSACTION`, (4) an expired intent is
rejected by the facilitator and by **the network** (`TRANSACTION_EXPIRED`), (5) the resolver proves VOID for an
intent that was never sent. **Time:** 60 min. **Depends:** P6, P13, P14.

**File: `packages/x402-hedera/src/resolver.ts`**

```ts
import { VOID_MARGIN_S, type Mirror } from '@forkos/shared';

export type IntentState =
  | { state: 'PAID'; consensusTimestamp: string }
  | { state: 'FAILED'; result: string; consensusTimestamp: string } // reached consensus, money did not move
  | { state: 'VOID'; provedAtS: number } // can never execute
  | { state: 'UNKNOWN'; retryAfterMs: number };

/**
 * The death-clock rule (I.3). Never re-sign while UNKNOWN; resend the same bytes or wait.
 * `mirror` only needs getTransaction, so tests can pass a fake.
 */
export async function resolveIntent(
  mirror: Pick<Mirror, 'getTransaction'>,
  txId: string,
  deadlineS: number,
  nowMs = Date.now(),
): Promise<IntentState> {
  const found = await mirror.getTransaction(txId);
  if (found.found) {
    return found.success
      ? { state: 'PAID', consensusTimestamp: found.consensusTimestamp }
      : { state: 'FAILED', result: found.result, consensusTimestamp: found.consensusTimestamp };
  }
  const nowS = nowMs / 1000;
  const voidAt = deadlineS + VOID_MARGIN_S;
  if (nowS > voidAt) return { state: 'VOID', provedAtS: Math.floor(nowS) };
  const untilVoidMs = Math.max(1000, Math.ceil((voidAt - nowS) * 1000));
  return { state: 'UNKNOWN', retryAfterMs: Math.min(5000, untilVoidMs) };
}
```

**File: `packages/x402-hedera/src/index.ts`** (final version)

```ts
export * from './intent';
export * from './payload';
export * from './resolver';
```

**File: `packages/x402-hedera/test/resolver.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { resolveIntent } from '../src/resolver';

const tx = '0.0.9@1793909231.000000000';
const deadline = 1793909351;
const notFound = { getTransaction: async () => ({ found: false as const }) };
const success = {
  getTransaction: async () => ({ found: true as const, success: true, result: 'SUCCESS', consensusTimestamp: '1793909240.1', memo: '', tx: {} as never }),
};
const failed = {
  getTransaction: async () => ({
    found: true as const,
    success: false,
    result: 'INSUFFICIENT_TOKEN_BALANCE',
    consensusTimestamp: '1793909240.1',
    memo: '',
    tx: {} as never,
  }),
};

describe('resolver (death clock)', () => {
  it('PAID whenever mirror has SUCCESS, even before the deadline', async () => {
    expect(await resolveIntent(success, tx, deadline, (deadline - 100) * 1000)).toEqual({
      state: 'PAID',
      consensusTimestamp: '1793909240.1',
    });
  });
  it('FAILED when consensus reached with a failure', async () => {
    expect((await resolveIntent(failed, tx, deadline, deadline * 1000)).state).toBe('FAILED');
  });
  it('UNKNOWN before deadline + 45 s, VOID after', async () => {
    expect((await resolveIntent(notFound, tx, deadline, (deadline + 44) * 1000)).state).toBe('UNKNOWN');
    expect((await resolveIntent(notFound, tx, deadline, (deadline + 46) * 1000)).state).toBe('VOID');
  });
});
```

**File: `scripts/smoke-pay.ts`**

```ts
// The proof. Run with the facilitator up (pnpm dev:facilitator).
import { readFileSync } from 'node:fs';
import { Transaction } from '@hiero-ledger/sdk';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { clientFor, hashscan, loadDeployments, Mirror, parsePrivateKey } from '../packages/shared/src/index';
import { buildIntentPayment, resolveIntent } from '../packages/x402-hedera/src/index';

const dep = loadDeployments();
const secrets = JSON.parse(readFileSync('.secrets/testnet-keys.json', 'utf8'));
const payerId = dep.baselineAgents[0]!;
const payerKey = secrets.baselineAgents[payerId] as string;
const fac = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL ?? 'http://localhost:4020' });
const mirror = new Mirror(process.env.MIRROR_URL);

const supported = await fac.getSupported();
const feePayer = supported.kinds.find((k) => k.network === 'hedera:testnet')?.extra?.feePayer as string;
const req: PaymentRequirements = {
  scheme: 'exact',
  network: 'hedera:testnet',
  asset: dep.token.id,
  amount: '1000', // 0.001 FUSD
  payTo: dep.providers['scribe-a']!.accountId,
  maxTimeoutSeconds: 180,
  extra: { feePayer },
};
const pr: PaymentRequired = { x402Version: 2, resource: { url: 'smoke://pay' }, accepts: [req] };

async function intent(nowOffsetMs = 0) {
  return buildIntentPayment(pr, req, {
    accountId: payerId,
    privateKey: payerKey,
    memo: `forkos:smoke${Date.now().toString(16).slice(-11)}:r0`.slice(0, 100),
    nowMs: () => Date.now() + nowOffsetMs,
    persist: async (i) => console.log('  persisted BEFORE send:', i.txId, 'deadline', i.deadlineS),
  });
}

// Direct network submission (bypassing every facilitator) to show what Hedera itself says.
async function networkSays(b64: string): Promise<string> {
  const client = clientFor(dep.facilitatorFeePayerId, process.env.FACILITATOR_FEE_PAYER_KEY!);
  try {
    const tx = Transaction.fromBytes(Buffer.from(b64, 'base64'));
    const signed = await tx.sign(parsePrivateKey(process.env.FACILITATOR_FEE_PAYER_KEY!));
    const resp = await signed.execute(client);
    return (await resp.getReceipt(client)).status.toString();
  } catch (err) {
    const status = (err as { status?: { toString(): string } }).status;
    return status ? status.toString() : (err as Error).message;
  } finally {
    client.close();
  }
}

console.log('1) settle a fresh intent through our facilitator');
const a = await intent();
const v = await fac.verify(a.payload, req);
console.log('  verify:', v.isValid, v.invalidReason ?? '');
const s = await fac.settle(a.payload, req);
console.log('  settle:', s.success, s.transaction, s.errorReason ?? '');
await new Promise((r) => setTimeout(r, 6000));
const st = await resolveIntent(mirror, a.intent.txId, a.intent.deadlineS);
console.log('  resolver:', st);
if (st.state === 'PAID') console.log('  HashScan:', hashscan.tx(st.consensusTimestamp));

console.log('2) replay the same payload through our facilitator');
const s2 = await fac.settle(a.payload, req);
console.log('  settle:', s2.success, s2.errorReason);

console.log('3) resubmit the same bytes straight to the network');
console.log('  network:', await networkSays(a.intent.transactionBase64));

console.log('4) an intent whose clock already ran out (valid start 130 s ago)');
const old = await intent(-130_000);
console.log('  facilitator verify:', (await fac.verify(old.payload, req)).invalidReason);
console.log('  network:', await networkSays(old.intent.transactionBase64));

console.log('5) an intent that is never sent → resolver after deadline + 45 s');
const never = await intent(-170_000);
console.log('  resolver:', await resolveIntent(mirror, never.intent.txId, never.intent.deadlineS));
```

**Commands**

```bash
pnpm test
pnpm dev:facilitator            # terminal 1
pnpm smoke:pay                  # terminal 2
```

**Exit checks** (copy the output into `docs/proof.md`; it goes in the README)

- [ ] 1) `verify: true`, `settle: true 0.0.<feePayer>@…`, resolver `PAID`, HashScan link opens and shows
      **0.001 FUSD** from the baseline account to `scribe-a`, memo `forkos:smoke…`
- [ ] 2) `settle: false forkos_replay_detected`
- [ ] 3) `network: DUPLICATE_TRANSACTION`
- [ ] 4) `facilitator verify: forkos_intent_expired`, `network: TRANSACTION_EXPIRED`
- [ ] 5) `resolver: { state: 'VOID', … }`
- [ ] 3 resolver tests pass

If 1) fails with a preflight error, check that `scribe-a` was created with unlimited auto-association (P6) and
that the baseline account holds FUSD. If FUSD settlement is impossible for a reason you cannot fix in 30 min,
set `PAY_ASSET=0.0.0` and `PAY_ASSET_DECIMALS=8` (HBAR) — everything else works unchanged.

**Commit:** `feat(x402-hedera): death-clock resolver + testnet proof (settle, replay, duplicate, expired, void)`

---
### Phase P16 — Provider: skeleton, config and Arkiv service directory

**Goal:** the "Scribe" paid service boots (one codebase, three instances), serves the sample audio, and
**publishes itself to the Arkiv service directory** (this is how agents *find* the endpoint — Hedera
requirement "an agent that finds the endpoint"). **Time:** 45 min. **Depends:** P7, P10, P11.

Two provider-only variables are added to ICD-2:

| Variable | Example | Notes |
|---|---|---|
| `API_ARKIV_ADDRESS` | `0xabc…` | public address of `API_ARKIV_KEY` (printed by `keys:new`); the provider trusts `AgentLink` entities only from this owner |
| `PROVIDER_ALLOW_CHAOS` | `true` locally / `true` on the demo instance | honours the `x-forkos-chaos-fail` header (forces a job failure *after* payment → refund demo) |

**File: `services/provider/src/config.ts`**

```ts
import {
  DEFAULT_MIRROR_URL,
  loadDeployments,
  loadEnv,
  zEvmAddr,
  zHederaId,
  zIntString,
  zPrivHex,
} from '@forkos/shared';
import { z } from 'zod';

export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  MIRROR_URL: z.string().url().default(DEFAULT_MIRROR_URL),
  FACILITATOR_URL: z.string().url(),
  PAY_ASSET: zHederaId,
  PAY_ASSET_DECIMALS: z.coerce.number().int().min(0).max(18),
  HCS_TOPIC_ID: zHederaId,
  PROVIDER_ID: z.enum(['scribe-a', 'scribe-b', 'scribe-premium']),
  PROVIDER_NAME: z.string().min(1).max(64),
  PROVIDER_PRICE: zIntString,
  PROVIDER_ACCOUNT_ID: zHederaId,
  PROVIDER_ACCOUNT_KEY: z.string().min(10),
  PROVIDER_PUBLIC_URL: z.string().url(),
  PROVIDER_ARKIV_KEY: zPrivHex,
  API_ARKIV_ADDRESS: zEvmAddr,
  ARKIV_ACCESS_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_STT_MODEL: z.string().default('whisper-1'),
  PROVIDER_ALLOW_CHAOS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const dep = loadDeployments();
export const OPERATOR_ID = dep.operatorId;
export const PROVIDER_ACCOUNTS = Object.values(dep.providers).map((p) => p.accountId);
export const ENDPOINT = `${env.PROVIDER_PUBLIC_URL.replace(/\/$/, '')}/v1/jobs`;
if (Buffer.byteLength(ENDPOINT) > 128) throw new Error('PROVIDER_PUBLIC_URL too long for an Arkiv str (128 bytes)');
```

**File: `services/provider/src/db.ts`**

```ts
import postgres from 'postgres';
import { env } from './config';

export const sql = postgres(env.DATABASE_URL, { max: 5 });

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
  created_at: Date;
  updated_at: Date;
};
```

**File: `services/provider/src/arkiv.ts`**

```ts
import { arkivPublic, arkivWallet } from '@forkos/shared';
import { env } from './config';

export const arkivPub = arkivPublic(env.ARKIV_ACCESS_KEY);
export const arkivProviderWallet = arkivWallet(env.ARKIV_ACCESS_KEY, env.PROVIDER_ARKIV_KEY as `0x${string}`);
```

**File: `services/provider/src/directory.ts`**

```ts
import { CAPABILITY, ExpirationTime, NETWORK, ServiceSchema, listServices, u64 } from '@forkos/shared';
import { ENDPOINT, env } from './config';
import { arkivProviderWallet, arkivPub } from './arkiv';

export let serviceKey: string | null = null;

/** Create or refresh our Service entity (owner = provider wallet). Lifetime 24 h, refreshed every 6 h. */
export async function publishService(): Promise<string> {
  const owner = arkivProviderWallet.account.address.toLowerCase();
  const values = {
    providerId: env.PROVIDER_ID,
    capability: CAPABILITY,
    network: NETWORK,
    asset: env.PAY_ASSET,
    price: u64(BigInt(env.PROVIDER_PRICE)),
    name: env.PROVIDER_NAME,
    endpoint: ENDPOINT,
    payTo: env.PROVIDER_ACCOUNT_ID,
  };
  const existing = (await listServices(arkivPub)).find((s) => s.providerId === env.PROVIDER_ID && s.owner === owner);
  if (existing) {
    const key = existing.key as `0x${string}`;
    await arkivProviderWallet.patchEntity(ServiceSchema, key, { set: values });
    await arkivProviderWallet.extendEntity({
      entityKey: key,
      expiration: ExpirationTime.atDate(new Date(Date.now() + 24 * 3600_000)),
    });
    serviceKey = existing.key;
    return existing.key;
  }
  const created = await arkivProviderWallet.createEntity(ServiceSchema, values, {
    expiration: ExpirationTime.fromHours(24),
  });
  serviceKey = created.entityKey;
  return created.entityKey;
}

export function startDirectoryRefresh(log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  const run = async () => {
    try {
      const key = await publishService();
      log.info({ key }, 'arkiv service published');
    } catch (err) {
      log.error({ err }, 'arkiv service publish failed');
    }
  };
  void run();
  setInterval(run, 6 * 3600_000);
}
```

**File: `services/provider/src/index.ts`** (P16 version — grows in P17–P22)

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { portFrom } from '@forkos/shared';
import Fastify from 'fastify';
import { env } from './config';
import { serviceKey, startDirectoryRefresh } from './directory';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 1_000_000 });

await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  prefix: '/',
});

app.get('/health', async () => ({
  ok: true,
  providerId: env.PROVIDER_ID,
  price: env.PROVIDER_PRICE,
  payTo: env.PROVIDER_ACCOUNT_ID,
  arkivServiceKey: serviceKey,
}));

startDirectoryRefresh(app.log);

const port = portFrom('PROVIDER_PORT', 4031);
await app.listen({ host: '0.0.0.0', port });
```

**Commands**

```bash
# put API_ARKIV_ADDRESS (address printed next to API_ARKIV_KEY) and PROVIDER_ALLOW_CHAOS=true in .env
pnpm dev:scribe-a        # terminal 1
pnpm dev:scribe-b        # terminal 2
pnpm dev:scribe-premium  # terminal 3
curl -s localhost:4031/health
```

**Exit checks**

- [ ] Each instance logs `arkiv service published` with a `0x…` key
- [ ] `/health` on 4031/4032/4033 shows the right `providerId`, `price` and a non-null `arkivServiceKey` (after ~5 s)
- [ ] Restarting an instance reuses the **same** key (patch + extend, not a new entity)
- [ ] The three Service entities are visible on the Arkiv explorer

**Commit:** `feat(provider): scribe service skeleton + arkiv service directory publishing`

---

### Phase P17 — Provider: the x402 challenge

**Goal:** `POST /v1/jobs` without payment returns a correct x402 `402` with `PAYMENT-REQUIRED`, priced in
FUSD, with the facilitator's `feePayer` merged in. **Time:** 35 min. **Depends:** P16, P12.

We use `x402ResourceServer` directly (not the Fastify middleware) because the middleware runs the handler
**before** settlement (verified in `@x402/fastify` source). Our order is: fence → verify → settle → run.

**File: `services/provider/src/x402.ts`**

```ts
import { NETWORK } from '@forkos/shared';
import { Transaction } from '@hiero-ledger/sdk';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { extractTransactionFromPayload } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import type { FastifyReply } from 'fastify';
import { ENDPOINT, env } from './config';

export const facilitatorClient = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });

export const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactHederaScheme({
    defaultAssets: { [NETWORK]: { asset: env.PAY_ASSET, decimals: env.PAY_ASSET_DECIMALS } },
  }),
);

/** Must be awaited once at boot: fetches /supported so requirements get extra.feePayer. */
export async function initX402(): Promise<void> {
  await resourceServer.initialize();
}

export async function requirements(): Promise<PaymentRequirements[]> {
  return resourceServer.buildPaymentRequirementsFromOptions(
    [
      {
        scheme: 'exact',
        network: NETWORK,
        payTo: env.PROVIDER_ACCOUNT_ID,
        price: { asset: env.PAY_ASSET, amount: env.PROVIDER_PRICE },
        maxTimeoutSeconds: 180,
      },
    ],
    {},
  );
}

export async function send402(reply: FastifyReply, reqs: PaymentRequirements[], error?: string) {
  const pr = await resourceServer.createPaymentRequiredResponse(
    reqs,
    {
      url: ENDPOINT,
      description: 'Transcribe and summarize one meeting recording',
      mimeType: 'application/json',
      serviceName: env.PROVIDER_NAME,
    },
    error,
  );
  return reply.code(402).header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(pr)).send(pr);
}

/** Transaction id of the payment inside an x402 payload (SDK format). */
export function txIdOfPayload(payload: PaymentPayload): string {
  const b64 = extractTransactionFromPayload(payload.payload as { transaction: string });
  const id = Transaction.fromBytes(Buffer.from(b64, 'base64')).transactionId;
  if (!id) throw new Error('payment transaction has no id');
  return id.toString();
}
```

**File: `services/provider/src/routes.ts`** (P17 version: challenge only; P18 replaces it)

```ts
import { H_AGENT, H_CLAIM, H_JOB, H_ROUND } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirements, send402 } from './x402';

export const JobBody = z.object({
  audioUrl: z.string().url(),
  inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const JobHeaders = z.object({
  [H_JOB]: z.string().regex(/^[0-9a-f]{64}$/),
  [H_ROUND]: z.coerce.number().int().nonnegative(),
  [H_AGENT]: z.string().regex(/^0x[0-9a-f]{40}$/),
  [H_CLAIM]: z.string().regex(/^0x[0-9a-f]{64}$/),
});

export function registerJobRoutes(app: FastifyInstance) {
  app.post('/v1/jobs', async (req, reply) => {
    const reqs = await requirements();
    return send402(reply, reqs);
  });
}
```

Update **`services/provider/src/index.ts`** — add before `startDirectoryRefresh(app.log);`:

```ts
import { initX402 } from './x402';
import { registerJobRoutes } from './routes';
// …
await initX402();
registerJobRoutes(app);
```

**Commands**

```bash
pnpm dev:facilitator & pnpm dev:scribe-a
curl -si -XPOST localhost:4031/v1/jobs -H 'content-type: application/json' -d '{}' | head -20
```

**Exit checks**

- [ ] Status `402`, header `PAYMENT-REQUIRED` present (base64)
- [ ] JSON body: `x402Version: 2`, `accepts[0]` = `{scheme:"exact", network:"hedera:testnet", asset:"<FUSD>", amount:"50000", payTo:"<scribe-a>", maxTimeoutSeconds:180, extra:{feePayer:"<facilitator fee payer>"}}`
- [ ] If `extra.feePayer` is missing → `initX402()` did not run or the facilitator is down

**Commit:** `feat(provider): x402 402 challenge priced in FUSD via our facilitator`

---

### Phase P18 — Provider: verify → settle → record (payment path)

**Goal:** the paid path in the correct order, idempotent by payment tx id. The fence (P19) and the real job
(P20) slot into marked places. **Time:** 60 min. **Depends:** P17.

Order of operations in `POST /v1/jobs` (this order *is* the safety property):

```text
0. parse headers/body                       (400 on error)
1. no PAYMENT-SIGNATURE → fence → 402 challenge   (stale/loser agents never even get a price)
2. decode payload, tx id
3. tx id already in prov_jobs → return that result (idempotent resend after a lost response)
4. fence                                     (409, nothing settled)
5. facilitator verify                        (402, nothing settled)
6. INSERT prov_jobs PAYING                   (record before settle: crash-safe, reconciler finishes it)
7. facilitator settle                        (402 + PAYMENT_FAILED on failure)
8. fence again → RUNNING (unique per job)    (if it fails now: FAILED → refund)
9. run job → DONE (or FAILED → refund)
10. 200 + PAYMENT-RESPONSE
```

**File: `services/provider/src/routes.ts`** (replaces P17)

```ts
import { H_AGENT, H_CLAIM, H_JOB, H_ROUND } from '@forkos/shared';
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from './config';
import { sql, type JobRow } from './db';
import { fence } from './fence';
import { runJob } from './jobs';
import { refundJob } from './refunds';
import { requirements, resourceServer, send402, txIdOfPayload } from './x402';

export const JobBody = z.object({
  audioUrl: z.string().url(),
  inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export const JobHeaders = z.object({
  [H_JOB]: z.string().regex(/^[0-9a-f]{64}$/),
  [H_ROUND]: z.coerce.number().int().nonnegative(),
  [H_AGENT]: z.string().regex(/^0x[0-9a-f]{40}$/),
  [H_CLAIM]: z.string().regex(/^0x[0-9a-f]{64}$/),
});

function fenceError(reply: FastifyReply, code: string, message: string) {
  return reply.code(409).send({ error: { code, message } });
}

/** Shape returned for a job row (200 when DONE). */
export function jobResponse(row: JobRow) {
  return {
    jobId: row.id,
    status: row.status,
    txId: row.payment_tx_id,
    transcript: row.transcript,
    summary: row.summary,
    outputHash: row.output_hash,
    refundTxId: row.refund_tx_id,
    error: row.error,
  };
}

export function registerJobRoutes(app: FastifyInstance) {
  app.post('/v1/jobs', async (req, reply) => {
    // 0. parse
    const h = JobHeaders.safeParse(req.headers);
    const b = JobBody.safeParse(req.body);
    if (!h.success || !b.success) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'missing ForkOS headers or body' } });
    }
    const jobKey = h.data[H_JOB];
    const round = h.data[H_ROUND];
    const agent = h.data[H_AGENT];
    const claimKey = h.data[H_CLAIM];
    const reqs = await requirements();
    const sig = (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined;

    // 1. challenge (after a fence, so losers/stale agents get 409 not a price)
    if (!sig) {
      const f = await fence({ jobKey, round, agent, claimKey });
      if (!f.ok) return fenceError(reply, f.code, f.message);
      return send402(reply, reqs);
    }

    // 2. decode
    let payload;
    let txId: string;
    try {
      payload = decodePaymentSignatureHeader(sig);
      txId = txIdOfPayload(payload);
    } catch {
      return send402(reply, reqs, 'invalid_payment_payload');
    }
    const matched = resourceServer.findMatchingRequirements(reqs, payload);
    if (!matched) return send402(reply, reqs, 'payment_requirements_mismatch');

    // 3. idempotent: this exact payment already processed?
    const [existing] = await sql<JobRow[]>`select * from prov_jobs where payment_tx_id = ${txId}`;
    if (existing) {
      if (existing.status === 'DONE') return reply.code(200).send(jobResponse(existing));
      if (existing.status === 'PAYING' || existing.status === 'RUNNING') return reply.code(202).send(jobResponse(existing));
      return reply.code(409).send({ error: { code: 'ALREADY_EXECUTED', message: `payment already ${existing.status}` }, job: jobResponse(existing) });
    }

    // 4. fence (nothing settled yet)
    const f1 = await fence({ jobKey, round, agent, claimKey });
    if (!f1.ok) return fenceError(reply, f1.code, f1.message);

    // 5. verify
    const verify = await resourceServer.verifyPayment(payload, matched);
    if (!verify.isValid) return send402(reply, reqs, verify.invalidReason ?? 'verification_failed');

    // 6. record before settling
    const id = `${env.PROVIDER_ID}:${txId}`;
    await sql`
      insert into prov_jobs (id, provider_id, job_key, round, agent_addr, payment_tx_id, payer_account, amount, status, audio_url, input_hash)
      values (${id}, ${env.PROVIDER_ID}, ${jobKey}, ${round}, ${agent}, ${txId}, ${verify.payer ?? null},
              ${matched.amount}, 'PAYING', ${b.data.audioUrl}, ${b.data.inputHash})
      on conflict (payment_tx_id) do nothing`;

    // 7. settle
    const settle = await resourceServer.settlePayment(payload, matched);
    if (!settle.success) {
      await sql`update prov_jobs set status = 'PAYMENT_FAILED', error = ${settle.errorReason ?? 'settle failed'}, updated_at = now() where id = ${id}`;
      return send402(reply, reqs, settle.errorReason ?? 'settlement_failed');
    }
    reply.header('PAYMENT-RESPONSE', encodePaymentResponseHeader(settle));

    // 8 + 9. fence again at the execution point, then run (or refund)
    const chaosFail = env.PROVIDER_ALLOW_CHAOS && req.headers['x-forkos-chaos-fail'] === '1';
    const row = await runJob(id, { jobKey, round, agent, claimKey, chaosFail }, req.log);
    if (row.status === 'FAILED') {
      const refunded = await refundJob(row, req.log);
      return reply.code(200).send(jobResponse(refunded));
    }
    // 10.
    return reply.code(200).send(jobResponse(row));
  });

  app.get<{ Params: { txId: string } }>('/v1/jobs/by-payment/:txId', async (req, reply) => {
    const [row] = await sql<JobRow[]>`select * from prov_jobs where payment_tx_id = ${req.params.txId}`;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'unknown payment' } });
    return jobResponse(row);
  });
}
```

> `fence`, `runJob` and `refundJob` are created in P19, P20 and P21. Until then, create these stubs so the
> service runs, then replace them:

**File: `services/provider/src/fence.ts`** (stub — replaced in P19)

```ts
export type FenceInput = { jobKey: string; round: number; agent: string; claimKey: string };
export type FenceResult = { ok: true } | { ok: false; code: string; message: string };
export async function fence(_i: FenceInput): Promise<FenceResult> {
  return { ok: true };
}
```

**File: `services/provider/src/jobs.ts`** (stub — replaced in P20)

```ts
import type { FastifyBaseLogger } from 'fastify';
import { sql, type JobRow } from './db';

export async function runJob(
  id: string,
  _ctx: { jobKey: string; round: number; agent: string; claimKey: string; chaosFail: boolean },
  _log: FastifyBaseLogger,
): Promise<JobRow> {
  const [row] = await sql<JobRow[]>`update prov_jobs set status = 'DONE', summary = 'stub', updated_at = now() where id = ${id} returning *`;
  return row!;
}
```

**File: `services/provider/src/refunds.ts`** (stub — replaced in P21)

```ts
import type { FastifyBaseLogger } from 'fastify';
import type { JobRow } from './db';

export async function refundJob(row: JobRow, _log: FastifyBaseLogger): Promise<JobRow> {
  return row;
}
```

**Exit checks** (end-to-end payment with a hand-made client comes in P29; here we check the guards)

- [ ] Missing headers → `400 BAD_REQUEST`
- [ ] Valid headers, no payment → `402` (stub fence returns ok)
- [ ] `PAYMENT-SIGNATURE: garbage` → `402` with `error: invalid_payment_payload`
- [ ] `pnpm typecheck` passes

**Commit:** `feat(provider): paid path — idempotent by tx id, record before settle, settle before run`

---

### Phase P19 — Provider: the fence (S5)

**Goal:** before pricing, before verifying, and again right before running, the provider proves from public
data that this request is the **live winner with current authority**. It trusts **HCS** for order and
**Arkiv** for live state, never the caller. **Time:** 50 min. **Depends:** P9, P10, P18.

Checks (in order; first failure wins):

| # | Check | Source | Error |
|---|---|---|---|
| F1 | header round == current round of the job | HCS referee | `ROUND_CLOSED` |
| F2 | job not already PAID/DONE/REFUNDED in this round (except the idempotent path handled earlier) | HCS referee | `ROUND_CLOSED` |
| F3 | winner exists and is this agent, and its claim key matches the header | HCS referee | `NOT_WINNER` |
| F4 | the Arkiv claim exists (not expired), is **owned by the agent**, matches job/round, status `WON`/`PAYING` | Arkiv | `NOT_WINNER` |
| F5 | HCS link of the agent is active and its epoch equals the claim epoch | HCS | `STALE_AUTHORITY` |
| F6 | Arkiv `AgentLink` (owner = API wallet) is `ACTIVE` with the same epoch | Arkiv | `STALE_AUTHORITY` |

F5 and F6 both exist on purpose: HCS is the ordered history, Arkiv is the live state a seller reads. If they
disagree (e.g. Arkiv write lagging), the request is refused — fail closed.

**File: `services/provider/src/hcs.ts`**

```ts
import { Mirror, TopicFollower } from '@forkos/shared';
import { env } from './config';

export const mirror = new Mirror(env.MIRROR_URL);
export const follower = new TopicFollower(mirror, env.HCS_TOPIC_ID);
```

**File: `services/provider/src/fence.ts`** (replaces the stub)

```ts
import { buildLinks, getAgentLink, getClaim, viewJob } from '@forkos/shared';
import { arkivPub } from './arkiv';
import { env, OPERATOR_ID, PROVIDER_ACCOUNTS } from './config';
import { follower } from './hcs';

export type FenceInput = { jobKey: string; round: number; agent: string; claimKey: string };
export type FenceResult = { ok: true; epoch: number } | { ok: false; code: string; message: string };

export async function fence(i: FenceInput): Promise<FenceResult> {
  await follower.sync();
  const opts = { operatorId: OPERATOR_ID, providerAccounts: PROVIDER_ACCOUNTS };
  const view = viewJob(follower.messages, i.jobKey, opts);

  // F1, F2
  if (view.round !== i.round) return { ok: false, code: 'ROUND_CLOSED', message: `current round is ${view.round}` };
  if (view.status === 'PAID' || view.status === 'DONE' || view.status === 'REFUNDED') {
    return { ok: false, code: 'ROUND_CLOSED', message: `round already ${view.status}` };
  }
  // F3
  if (!view.winner || view.winner.agent !== i.agent) return { ok: false, code: 'NOT_WINNER', message: 'agent is not the HCS winner' };
  if (view.winner.arkivKey !== i.claimKey) return { ok: false, code: 'NOT_WINNER', message: 'claim key does not match the winning claim' };

  // F4
  const claim = await getClaim(arkivPub, i.claimKey);
  if (!claim) return { ok: false, code: 'NOT_WINNER', message: 'winning claim not live on Arkiv (expired?)' };
  if (claim.owner !== i.agent) return { ok: false, code: 'NOT_WINNER', message: 'claim not owned by the agent' };
  if (claim.job !== i.jobKey || claim.round !== i.round) return { ok: false, code: 'NOT_WINNER', message: 'claim is for another job/round' };
  if (claim.status !== 'WON' && claim.status !== 'PAYING') return { ok: false, code: 'NOT_WINNER', message: `claim status ${claim.status}` };

  // F5
  const link = buildLinks(follower.messages, opts).get(i.agent);
  if (!link || !link.active || link.epoch !== view.winner.epoch) {
    return { ok: false, code: 'STALE_AUTHORITY', message: 'agent revoked or epoch outdated (HCS)' };
  }
  // F6
  const live = await getAgentLink(arkivPub, i.agent, env.API_ARKIV_ADDRESS);
  if (!live || live.status !== 'ACTIVE' || live.epoch !== view.winner.epoch) {
    return { ok: false, code: 'STALE_AUTHORITY', message: 'agent link not ACTIVE at the current epoch (Arkiv)' };
  }
  return { ok: true, epoch: link.epoch };
}
```

Update **`services/provider/src/index.ts`** — start the topic follower at boot (before `listen`):

```ts
import { follower } from './hcs';
// …
follower.start(3000, () => {});
```

**Exit checks** (full live checks happen in P39 chaos; here: unit-level confidence)

- [ ] `pnpm typecheck` passes
- [ ] With an unknown job key in headers and no payment, `/v1/jobs` returns `409 NOT_WINNER` (no claims yet)
- [ ] Provider log shows no `[topic-follower]` errors

**Commit:** `feat(provider): fence — HCS winner + Arkiv live claim + link epoch, checked before price, verify and run`

---

### Phase P20 — Provider: the real job (Whisper + summary)

**Goal:** download the audio, check its hash against `inputHash`, transcribe with OpenAI, summarize, store,
and re-fence right before execution. **Time:** 45 min. **Depends:** P19.

**File: `services/provider/src/transcribe.ts`**

```ts
import { canonicalJson, inputHashOf, sha256Hex } from '@forkos/shared';
import OpenAI, { toFile } from 'openai';
import { env } from './config';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
const MAX_BYTES = 24 * 1024 * 1024; // Whisper upload limit is 25 MB

export class InputHashMismatch extends Error {}

export async function fetchAudio(url: string, expectedHash: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio download failed: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error('audio too large');
  const got = inputHashOf(buf);
  if (got !== expectedHash) throw new InputHashMismatch(`inputHash mismatch: got ${got}`);
  return buf;
}

export async function transcribeAndSummarize(audio: Uint8Array): Promise<{ transcript: string; summary: string; outputHash: string }> {
  const file = await toFile(audio, 'meeting.mp3', { type: 'audio/mpeg' });
  const tr = await openai.audio.transcriptions.create({ file, model: env.OPENAI_STT_MODEL });
  const transcript = tr.text;
  const chat = await openai.chat.completions.create({
    model: env.OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content: 'Summarize this meeting transcript as 3-6 short bullet points: decisions first, then action items with owners.',
      },
      { role: 'user', content: transcript.slice(0, 24_000) },
    ],
  });
  const summary = chat.choices[0]?.message?.content?.trim() ?? '';
  const outputHash = sha256Hex(canonicalJson({ transcript, summary }));
  return { transcript, summary, outputHash };
}
```

**File: `services/provider/src/jobs.ts`** (replaces the stub)

```ts
import type { FastifyBaseLogger } from 'fastify';
import { sql, type JobRow } from './db';
import { fence } from './fence';
import { fetchAudio, transcribeAndSummarize } from './transcribe';

type Ctx = { jobKey: string; round: number; agent: string; claimKey: string; chaosFail: boolean };

async function fail(id: string, error: string): Promise<JobRow> {
  const [row] = await sql<JobRow[]>`update prov_jobs set status = 'FAILED', error = ${error}, updated_at = now() where id = ${id} returning *`;
  return row!;
}

/** Called only after settlement succeeded. Executes at most once per (provider, job). */
export async function runJob(id: string, ctx: Ctx, log: FastifyBaseLogger): Promise<JobRow> {
  // Re-fence at the execution point (authority could have been revoked during settlement).
  // NOTE: the round is now PAID on Hedera but SETTLED is not on HCS yet, so the fence still sees PAYING.
  const f = await fence(ctx);
  if (!f.ok && f.code !== 'ROUND_CLOSED') return fail(id, `fence after settle: ${f.code} ${f.message}`);

  // PAYING → RUNNING; the partial unique index prov_jobs_one_exec forbids a second RUNNING/DONE for this job.
  try {
    const moved = await sql`update prov_jobs set status = 'RUNNING', updated_at = now() where id = ${id} and status = 'PAYING' returning id`;
    if (moved.length === 0) {
      const [row] = await sql<JobRow[]>`select * from prov_jobs where id = ${id}`;
      return row!;
    }
  } catch (err) {
    return fail(id, `already executed for this job: ${(err as Error).message}`);
  }

  const [row] = await sql<JobRow[]>`select * from prov_jobs where id = ${id}`;
  try {
    if (ctx.chaosFail) throw new Error('chaos: forced failure after payment');
    const audio = await fetchAudio(row!.audio_url, row!.input_hash);
    const out = await transcribeAndSummarize(audio);
    const [done] = await sql<JobRow[]>`
      update prov_jobs set status = 'DONE', transcript = ${out.transcript}, summary = ${out.summary},
             output_hash = ${out.outputHash}, updated_at = now()
       where id = ${id} returning *`;
    log.info({ id, outputHash: out.outputHash }, 'job done');
    return done!;
  } catch (err) {
    log.warn({ id, err: (err as Error).message }, 'job failed after payment');
    return fail(id, (err as Error).message);
  }
}
```

> The `ROUND_CLOSED` exception in the post-settle fence: right after settlement the API has not yet published
> `SETTLED`, but if Mirror-lag made it visible, the fence would see `PAID` for *our own* payment. Every other
> fence failure after settlement leads to a refund.

**Exit checks**

- [ ] `pnpm typecheck` passes
- [ ] (live check happens in P29 once a winner can pay)

**Commit:** `feat(provider): real job — hash-checked audio, whisper transcription, summary, re-fence before run`

---

### Phase P21 — Provider: HTS refunds + reconciler

**Goal:** if a paid job fails, the provider sends the money back **in HTS** and logs `REFUND` on HCS. A
reconciler finishes anything a crash left half-done. This is the "revert" verb and the second native service
for **No Solidity**. **Time:** 50 min. **Depends:** P20.

**File: `services/provider/src/refunds.ts`** (replaces the stub)

```ts
import { clientFor, publishHcs } from '@forkos/shared';
import { Hbar, TransferTransaction } from '@hiero-ledger/sdk';
import type { FastifyBaseLogger } from 'fastify';
import { env } from './config';
import { sql, type JobRow } from './db';

const client = clientFor(env.PROVIDER_ACCOUNT_ID, env.PROVIDER_ACCOUNT_KEY);

/** Refund a FAILED job to the payer in the payment asset; idempotent (refund_tx_id set once). */
export async function refundJob(row: JobRow, log: Pick<FastifyBaseLogger, 'info' | 'error'>): Promise<JobRow> {
  if (row.status !== 'FAILED' || row.refund_tx_id) return row;
  if (!row.payer_account) {
    log.error({ id: row.id }, 'cannot refund: unknown payer');
    return row;
  }
  // Claim the refund first so two workers never refund twice.
  const claimed = await sql`update prov_jobs set refund_tx_id = 'PENDING', updated_at = now()
                             where id = ${row.id} and refund_tx_id is null returning id`;
  if (claimed.length === 0) return row;

  const amount = BigInt(row.amount);
  const tx = new TransferTransaction().setTransactionMemo(`forkos:refund:${row.job_key.slice(0, 16)}:r${row.round}`);
  if (env.PAY_ASSET === '0.0.0') {
    tx.addHbarTransfer(env.PROVIDER_ACCOUNT_ID, Hbar.fromTinybars((-amount).toString())).addHbarTransfer(
      row.payer_account,
      Hbar.fromTinybars(amount.toString()),
    );
  } else {
    tx.addTokenTransfer(env.PAY_ASSET, env.PROVIDER_ACCOUNT_ID, -amount).addTokenTransfer(env.PAY_ASSET, row.payer_account, amount);
  }
  try {
    const resp = await tx.execute(client);
    await resp.getReceipt(client);
    const refundTx = resp.transactionId.toString();
    await publishHcs(client, env.HCS_TOPIC_ID, {
      v: 1,
      t: 'REFUND',
      job: row.job_key,
      round: row.round,
      tx: row.payment_tx_id,
      rtx: refundTx,
      amt: row.amount.toString(),
    });
    const [updated] = await sql<JobRow[]>`update prov_jobs set status = 'REFUNDED', refund_tx_id = ${refundTx}, updated_at = now()
                                           where id = ${row.id} returning *`;
    log.info({ id: row.id, refundTx }, 'refunded');
    return updated!;
  } catch (err) {
    await sql`update prov_jobs set refund_tx_id = null, updated_at = now() where id = ${row.id}`;
    log.error({ id: row.id, err: (err as Error).message }, 'refund failed; will retry');
    return row;
  }
}
```

> The HBAR branch (same `Hbar.fromTinybars` pattern as the reference signer) only matters with the
> `PAY_ASSET=0.0.0` fallback; FUSD is the default.

**File: `services/provider/src/reconciler.ts`**

```ts
import { VALID_DURATION_S, VOID_MARGIN_S, validStartSecondsOf } from '@forkos/shared';
import type { FastifyBaseLogger } from 'fastify';
import { sql, type JobRow } from './db';
import { mirror } from './hcs';
import { runJob } from './jobs';
import { refundJob } from './refunds';

/**
 * Every 15 s:
 *  - PAYING older than 20 s (crash between record and settle response): ask Mirror Node.
 *      PAID → run the job (or refund via FAILED).  FAILED/VOID → PAYMENT_FAILED.  Unknown → wait.
 *  - RUNNING older than 10 min (crash mid-job) → FAILED.
 *  - FAILED with no refund → refund.
 */
export function startReconciler(log: FastifyBaseLogger) {
  const tick = async () => {
    try {
      const paying = await sql<JobRow[]>`select * from prov_jobs where status = 'PAYING' and updated_at < now() - interval '20 seconds'`;
      for (const row of paying) {
        const found = await mirror.getTransaction(row.payment_tx_id);
        const deadline = validStartSecondsOf(row.payment_tx_id) + VALID_DURATION_S;
        if (found.found && found.success) {
          log.info({ id: row.id }, 'reconciler: payment settled, running job');
          const after = await runJob(row.id, { jobKey: row.job_key, round: row.round, agent: row.agent_addr, claimKey: '', chaosFail: false }, log);
          if (after.status === 'FAILED') await refundJob(after, log);
        } else if ((found.found && !found.success) || Date.now() / 1000 > deadline + VOID_MARGIN_S) {
          await sql`update prov_jobs set status = 'PAYMENT_FAILED', error = 'payment did not settle (reconciler)', updated_at = now() where id = ${row.id}`;
        }
      }
      await sql`update prov_jobs set status = 'FAILED', error = coalesce(error, 'timed out while running'), updated_at = now()
                 where status = 'RUNNING' and updated_at < now() - interval '10 minutes'`;
      const failed = await sql<JobRow[]>`select * from prov_jobs where status = 'FAILED' and refund_tx_id is null`;
      for (const row of failed) await refundJob(row, log);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'reconciler tick failed');
    }
  };
  setInterval(tick, 15_000);
}
```

> The reconciler passes `claimKey: ''` to `runJob`; the re-fence then fails with `NOT_WINNER` and the job is
> refunded. That is deliberate: after a crash we cannot re-prove the claim, so we return the money rather than
> run a job we cannot justify. (The normal path never goes through the reconciler.)

Update **`services/provider/src/index.ts`** — after `follower.start(...)`:

```ts
import { startReconciler } from './reconciler';
// …
startReconciler(app.log);
```

**Exit checks**

- [ ] `pnpm typecheck` passes
- [ ] (live: P39 `chaos-fail` produces a REFUND visible on HashScan and on HCS)

**Commit:** `feat(provider): HTS refunds with REFUND on HCS + crash reconciler`

---

### Phase P22 — Provider: baseline route + sample meeting audio

**Goal:** (1) the **naive** paid endpoint used by the baseline lane — stock `@x402/fastify` middleware, no
fence, exactly how most x402 services are built today; (2) a ~45 s synthetic meeting recording served by the
provider, so the demo never depends on someone's personal audio. **Time:** 35 min. **Depends:** P17, P20.

**File: `services/provider/src/baseline.ts`**

```ts
import { NETWORK } from '@forkos/shared';
import { paymentMiddleware } from '@x402/fastify';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from './config';
import { fetchAudio, transcribeAndSummarize } from './transcribe';
import { resourceServer } from './x402';

const Body = z.object({ audioUrl: z.string().url(), inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/) });

/** Stock x402: no fence, handler runs before settlement. This is what the baseline lane calls. */
export function registerBaseline(app: FastifyInstance) {
  paymentMiddleware(
    app,
    {
      'POST /v1/baseline/jobs': {
        accepts: [
          {
            scheme: 'exact',
            network: NETWORK,
            payTo: env.PROVIDER_ACCOUNT_ID,
            price: { asset: env.PAY_ASSET, amount: env.PROVIDER_PRICE },
            maxTimeoutSeconds: 180,
          },
        ],
        description: 'Baseline (unfenced) transcription',
      },
    },
    resourceServer,
  );

  app.post('/v1/baseline/jobs', async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'bad body' } });
    const audio = await fetchAudio(b.data.audioUrl, b.data.inputHash);
    const out = await transcribeAndSummarize(audio);
    return { provider: env.PROVIDER_ID, summary: out.summary, outputHash: out.outputHash };
  });
}
```

Final **`services/provider/src/index.ts`**:

**File: `services/provider/src/index.ts`**

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { portFrom } from '@forkos/shared';
import Fastify from 'fastify';
import { registerBaseline } from './baseline';
import { env } from './config';
import { serviceKey, startDirectoryRefresh } from './directory';
import { follower } from './hcs';
import { startReconciler } from './reconciler';
import { registerJobRoutes } from './routes';
import { initX402 } from './x402';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 1_000_000 });

await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  prefix: '/',
});

app.get('/health', async () => ({
  ok: true,
  providerId: env.PROVIDER_ID,
  price: env.PROVIDER_PRICE,
  payTo: env.PROVIDER_ACCOUNT_ID,
  arkivServiceKey: serviceKey,
  hcsSeq: follower.latestSeq,
}));

await initX402();
registerJobRoutes(app);
registerBaseline(app);
follower.start(3000, () => {});
startReconciler(app.log);
startDirectoryRefresh(app.log);

const port = portFrom('PROVIDER_PORT', 4031);
await app.listen({ host: '0.0.0.0', port });
```

**File: `scripts/make-sample-audio.ts`**

```ts
// Generates services/provider/public/sample-meeting.mp3 (~45 s) with OpenAI TTS. Run once, commit the file.
import { writeFileSync } from 'node:fs';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const script = `Okay, let's start the weekly sync. First item: the payments launch.
Priya says the checkout integration is done and tested on testnet.
We agreed to ship it next Tuesday, not Friday, because the audit notes come back Monday.
Second item: the support backlog. Rahul will triage the forty open tickets by Thursday,
and anything about refunds goes to finance first.
Third item: the AI agent pilot. The agents kept paying twice when the network timed out,
so we are adding an exactly-once payment layer before we give them a bigger budget.
Action items: Priya ships checkout Tuesday. Rahul clears the backlog Thursday.
Austin owns the agent payment fix. That's it, thanks everyone.`;

const speech = await openai.audio.speech.create({
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  input: script,
  response_format: 'mp3',
});
const bytes = Buffer.from(await speech.arrayBuffer());
writeFileSync('services/provider/public/sample-meeting.mp3', bytes);
console.log('wrote services/provider/public/sample-meeting.mp3', bytes.length, 'bytes');
```

**Commands**

```bash
pnpm audio:sample
pnpm dev:scribe-a
curl -sI localhost:4031/sample-meeting.mp3 | head -3
curl -si -XPOST localhost:4031/v1/baseline/jobs -H 'content-type: application/json' -d '{}' | head -5
```

**Exit checks**

- [ ] `sample-meeting.mp3` exists (~300–800 KB) and is served with `200`
- [ ] `/v1/baseline/jobs` without payment → `402` (from the stock middleware)
- [ ] `/health` shows `hcsSeq` > 0 once the topic has messages

**Commit:** `feat(provider): naive baseline endpoint (stock x402 middleware) + synthetic sample meeting audio`

---
### Phase P23 — API: skeleton (config, crypto, SSE bus, auth, clients)

**Goal:** the API process boots with every shared building block: typed config, encrypted key storage, token
hashing, an SSE event bus backed by Postgres, Hedera/Mirror/HCS/Arkiv clients, auth helpers and a uniform error
handler. **Time:** 60 min. **Depends:** P10, P11.

One API-only variable is added to ICD-2: `SAMPLE_AUDIO_URL` = `<scribe-a public url>/sample-meeting.mp3`.

**File: `services/api/src/config.ts`**

```ts
import { DEFAULT_MIRROR_URL, loadDeployments, loadEnv, zHederaId, zIntString, zPrivHex } from '@forkos/shared';
import { z } from 'zod';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 hex chars (32 bytes)');

export const env = loadEnv({
  DATABASE_URL: z.string().min(1),
  MIRROR_URL: z.string().url().default(DEFAULT_MIRROR_URL),
  OPERATOR_ID: zHederaId,
  OPERATOR_KEY: z.string().min(10),
  PAY_ASSET: zHederaId,
  PAY_ASSET_DECIMALS: z.coerce.number().int().min(0).max(18),
  HCS_TOPIC_ID: zHederaId,
  FACILITATOR_URL: z.string().url(),
  ARKIV_ACCESS_KEY: z.string().min(1),
  API_ARKIV_KEY: zPrivHex,
  AGENT_ARKIV_FUND_WEI: zIntString.default('50000000000000000'),
  AGENT_HBAR_FUND: z.coerce.number().positive().default(5),
  HUMAN_FUSD_FUND: zIntString.default('20000000'),
  HUMAN_HBAR_FUND: z.coerce.number().positive().default(2),
  API_PUBLIC_URL: z.string().url(),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: hex32,
  KEY_ENCRYPTION_SECRET: hex32,
  HUMAN_SALT: hex32,
  WORLD_ISSUER: z.string().url(),
  WORLD_CLIENT_ID: z.string().min(1),
  WORLD_CLIENT_SECRET: z.string().min(1),
  WORLD_SUB_STABLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  WORLD_FRESH_SECONDS: z.coerce.number().int().positive().default(300),
  POLICY_DEFAULT_CAP: zIntString.default('1000000'),
  POLICY_DEFAULT_DAILY: zIntString.default('5000000'),
  DEMO_KEY: z.string().min(16),
  SAMPLE_AUDIO_URL: z.string().url(),
});

export const dep = loadDeployments();
if (dep.operatorId !== env.OPERATOR_ID) throw new Error('OPERATOR_ID differs from deployments/testnet.json');
if (dep.topicId !== env.HCS_TOPIC_ID) throw new Error('HCS_TOPIC_ID differs from deployments/testnet.json');

export const PROVIDER_ACCOUNTS = Object.values(dep.providers).map((p) => p.accountId);
export const PROVIDER_IDS = Object.keys(dep.providers);
export const REFEREE = { operatorId: env.OPERATOR_ID, providerAccounts: PROVIDER_ACCOUNTS };
export const WEB_ORIGINS = env.WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
```

**File: `services/api/src/db.ts`**

```ts
import postgres from 'postgres';
import { env } from './config';

export const sql = postgres(env.DATABASE_URL, { max: 10 });

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
  arkiv_key: string | null;
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
  created_at: Date;
  updated_at: Date;
};
```

> postgres.js returns `bigint` columns as **strings**; always wrap with `BigInt(...)`/`Number(...)` when doing math.

**File: `services/api/src/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './config';

const KEY = Buffer.from(env.KEY_ENCRYPTION_SECRET, 'hex');

/** AES-256-GCM. Output: iv.tag.ciphertext (base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !enc) throw new Error('bad sealed value');
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function newToken(prefix: 'fos' | 'fat'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

/** Tokens are stored only as peppered hashes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(env.SESSION_SECRET).update(token).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}
```

**File: `services/api/src/events.ts`**

```ts
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WEB_ORIGINS } from './config';
import { sql } from './db';

const clients = new Set<ServerResponse>();

/** Persist + broadcast. Data must be JSON-safe (convert bigint to string before calling). */
export async function emit(name: string, data: Record<string, unknown>): Promise<void> {
  const [row] = await sql<{ id: string }[]>`insert into events (name, data) values (${name}, ${sql.json(data as never)}) returning id`;
  const frame = `id: ${row!.id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
}

export function registerSse(app: FastifyInstance) {
  app.get('/v1/events', async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    };
    if (origin && (WEB_ORIGINS.includes(origin) || WEB_ORIGINS.includes('*'))) headers['access-control-allow-origin'] = origin;
    raw.writeHead(200, headers);

    // Replay: after Last-Event-ID, else the last 100 events.
    const last = Number(req.headers['last-event-id'] ?? 0);
    const backlog = last
      ? await sql<{ id: string; name: string; data: unknown }[]>`select id, name, data from events where id > ${last} order by id asc limit 500`
      : (await sql<{ id: string; name: string; data: unknown }[]>`select id, name, data from events order by id desc limit 100`).reverse();
    for (const e of backlog) raw.write(`id: ${e.id}\nevent: ${e.name}\ndata: ${JSON.stringify(e.data)}\n\n`);

    clients.add(raw);
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(raw);
    });
  });
}
```

**File: `services/api/src/clients.ts`**

```ts
import { arkivPublic, arkivWallet, clientFor, Mirror, parsePrivateKey, TopicFollower } from '@forkos/shared';
import { env } from './config';

export const operatorKey = parsePrivateKey(env.OPERATOR_KEY);
export const hedera = clientFor(env.OPERATOR_ID, operatorKey);
export const mirror = new Mirror(env.MIRROR_URL);
export const follower = new TopicFollower(mirror, env.HCS_TOPIC_ID);
export const arkivPub = arkivPublic(env.ARKIV_ACCESS_KEY);
export const arkivApi = arkivWallet(env.ARKIV_ACCESS_KEY, env.API_ARKIV_KEY as `0x${string}`);
export const API_ARKIV_ADDRESS = arkivApi.account.address.toLowerCase();
```

**File: `services/api/src/auth.ts`**

```ts
import { ApiError } from '@forkos/shared';
import type { FastifyRequest } from 'fastify';
import { env } from './config';
import { hashToken } from './crypto';
import { sql, type AgentRow, type HumanRow } from './db';

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export async function requireOwner(req: FastifyRequest): Promise<HumanRow> {
  const t = bearer(req);
  if (!t || !t.startsWith('fos_')) throw new ApiError('UNAUTHORIZED', 'owner token required');
  const [row] = await sql<HumanRow[]>`
    select h.* from owner_sessions s join humans h on h.human_hash = s.human_hash
     where s.token_hash = ${hashToken(t)} and s.expires_at > now()`;
  if (!row) throw new ApiError('UNAUTHORIZED', 'owner session invalid or expired');
  return row;
}

export async function requireAgent(req: FastifyRequest): Promise<AgentRow> {
  const t = bearer(req);
  if (!t || !t.startsWith('fat_')) throw new ApiError('UNAUTHORIZED', 'agent token required');
  const [row] = await sql<(AgentRow & { token_epoch: number })[]>`
    select a.*, t.epoch as token_epoch from agent_tokens t join agents a on a.agent_addr = t.agent_addr
     where t.token_hash = ${hashToken(t)} and t.revoked_at is null`;
  if (!row) throw new ApiError('UNAUTHORIZED', 'agent token invalid');
  if (row.status !== 'ACTIVE' || row.token_epoch !== row.epoch) {
    throw new ApiError('STALE_AUTHORITY', 'agent revoked or token from an old epoch');
  }
  return row;
}

/** Either an owner (any job of theirs) or an agent (jobs of its human). Returns the human hash. */
export async function requireOwnerOrAgent(req: FastifyRequest): Promise<string> {
  const t = bearer(req);
  if (t?.startsWith('fat_')) return (await requireAgent(req)).human_hash;
  return (await requireOwner(req)).human_hash;
}

export function requireDemo(req: FastifyRequest): void {
  if (req.headers['x-demo-key'] !== env.DEMO_KEY) throw new ApiError('FORBIDDEN', 'demo key required');
}
```

**File: `services/api/src/index.ts`** (P23 version — routes are added phase by phase)

```ts
import cors from '@fastify/cors';
import { ApiError, NETWORK, portFrom } from '@forkos/shared';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { env, WEB_ORIGINS } from './config';
import { follower } from './clients';
import { registerSse } from './events';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 1_000_000 });

await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || WEB_ORIGINS.includes('*') || WEB_ORIGINS.includes(origin)),
  allowedHeaders: ['content-type', 'authorization', 'x-demo-key', 'last-event-id'],
  methods: ['GET', 'POST', 'PUT'],
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ApiError) return reply.code(err.status).send(err.toJSON());
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
  }
  req.log.error({ err }, 'unhandled');
  return reply.code(500).send({ error: { code: 'UPSTREAM_FAILED', message: (err as Error).message } });
});

app.get('/v1/health', async () => ({
  ok: true,
  network: NETWORK,
  topicId: env.HCS_TOPIC_ID,
  asset: env.PAY_ASSET,
  hcsSeq: follower.latestSeq,
  version: '0.1.0',
}));

registerSse(app);
follower.start(2000, () => {});

const port = portFrom('API_PORT', 4000);
await app.listen({ host: '0.0.0.0', port });
```

**Commands**

```bash
pnpm dev:api
curl -s localhost:4000/v1/health
curl -sN localhost:4000/v1/events   # stays open; Ctrl-C to stop
```

**Exit checks**

- [ ] API boots; `/v1/health` shows `ok:true` and `hcsSeq` ≥ 0
- [ ] `/v1/events` stays open and prints `: ping` every 15 s
- [ ] Wrong `.env` (e.g. remove `HUMAN_SALT`) → boot fails with a readable `Invalid environment` list

**Commit:** `feat(api): skeleton — config, aes-gcm key storage, peppered tokens, postgres-backed SSE, auth, clients`

---

### Phase P24 — API: World device flow + owner sign-in

**Goal:** the reusable World ID module (start, poll, validate ID token in the backend) running as a background
worker, plus owner sign-in that creates the human's **budget account** (a Hedera account funded with FUSD that
only the API can sign for). **Time:** 90 min. **Depends:** P4, P23.

Validation rules (from the World docs; every one is enforced):

| Check | Why |
|---|---|
| ID token signature (RS256) against `jwks_uri` from discovery, via `jose.jwtVerify` | never trust an unvalidated token |
| `iss` == discovered issuer, `aud` == our client id, `exp` | standard |
| `auth_time` present, ≥ attempt start − 5 s, and now − `auth_time` ≤ `WORLD_FRESH_SECONDS` | fresh authentication for *this* attempt |
| for REVOKE/OVERCAP with `WORLD_SUB_STABLE=true`: `claims={"id_token":{"sub":{"value":<owner sub>}}}` is sent, **and** we re-check `sub` | a different human ends in `access_denied`; defence in depth |
| poll no faster than `interval`; `slow_down` → +5 s; stop on `access_denied`, `expired_token`, other errors; HTTP 503 → retry later, never approval | device grant rules |
| `device_code`, tokens and `sub` never leave the backend | World docs |

**File: `services/api/src/world.ts`**

```ts
import { ApiError } from '@forkos/shared';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from './config';
import { decrypt, encrypt, newId } from './crypto';
import { sql, type AttemptRow } from './db';

type Discovery = { issuer: string; device_authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
let disco: Discovery | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function discovery(): Promise<Discovery> {
  if (disco) return disco;
  const res = await fetch(`${env.WORLD_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new ApiError('WORLD_UNAVAILABLE', `discovery failed: ${res.status}`);
  const d = (await res.json()) as Discovery;
  if (!d.device_authorization_endpoint) throw new ApiError('UPSTREAM_FAILED', 'issuer has no device_authorization_endpoint');
  disco = d;
  jwks = createRemoteJWKSet(new URL(d.jwks_uri));
  return d;
}

export type AttemptPublic = {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
};

export function attemptPublic(row: AttemptRow): AttemptPublic {
  return {
    attemptId: row.id,
    userCode: row.user_code,
    verificationUri: row.verification_uri,
    verificationUriComplete: row.verification_uri_complete,
    expiresIn: Math.max(0, Math.round((row.expires_at.getTime() - Date.now()) / 1000)),
    interval: row.interval_s,
  };
}

export async function startDeviceFlow(
  kind: AttemptRow['kind'],
  opts: { expectedSub?: string | null; humanHash?: string | null; context?: Record<string, unknown> } = {},
): Promise<AttemptRow> {
  const d = await discovery();
  const body = new URLSearchParams({ client_id: env.WORLD_CLIENT_ID, client_secret: env.WORLD_CLIENT_SECRET, scope: 'openid' });
  const pinSub = Boolean(opts.expectedSub && env.WORLD_SUB_STABLE);
  if (pinSub) body.set('claims', JSON.stringify({ id_token: { sub: { value: opts.expectedSub } } }));

  const res = await fetch(d.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (res.status === 503 || res.status === 429) throw new ApiError('WORLD_UNAVAILABLE', `World returned ${res.status}`);
  const j = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
  };
  if (!res.ok || !j.device_code || !j.user_code || !j.verification_uri) {
    throw new ApiError('UPSTREAM_FAILED', `device_authorization failed: ${j.error ?? res.status}`);
  }
  const id = newId('wa');
  const interval = j.interval ?? 5;
  const [row] = await sql<AttemptRow[]>`
    insert into world_attempts (id, kind, status, device_code_enc, user_code, verification_uri, verification_uri_complete,
                                interval_s, expires_at, next_poll_at, expected_sub, human_hash, context)
    values (${id}, ${kind}, 'PENDING', ${encrypt(j.device_code)}, ${j.user_code}, ${j.verification_uri},
            ${j.verification_uri_complete ?? null}, ${interval},
            now() + make_interval(secs => ${j.expires_in ?? 1200}), now() + make_interval(secs => ${interval}),
            ${pinSub ? opts.expectedSub! : null}, ${opts.humanHash ?? null}, ${sql.json((opts.context ?? {}) as never)})
    returning *`;
  return row!;
}

type PollOutcome = AttemptRow['status'];

/** One poll step for one attempt; persists the outcome. */
export async function pollOnce(row: AttemptRow): Promise<PollOutcome> {
  if (row.expires_at.getTime() < Date.now()) {
    await sql`update world_attempts set status = 'EXPIRED', reason = 'device code expired', updated_at = now() where id = ${row.id}`;
    return 'EXPIRED';
  }
  const d = await discovery();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: env.WORLD_CLIENT_ID,
      client_secret: env.WORLD_CLIENT_SECRET,
      device_code: decrypt(row.device_code_enc),
    }),
  });

  if (res.status === 503) {
    await sql`update world_attempts set next_poll_at = now() + make_interval(secs => ${row.interval_s * 2}), updated_at = now() where id = ${row.id}`;
    return 'PENDING';
  }
  const j = (await res.json()) as { error?: string; id_token?: string };

  if (!res.ok || !j.id_token) {
    switch (j.error) {
      case 'authorization_pending':
        await sql`update world_attempts set next_poll_at = now() + make_interval(secs => ${row.interval_s}), updated_at = now() where id = ${row.id}`;
        return 'PENDING';
      case 'slow_down':
        await sql`update world_attempts set interval_s = interval_s + 5,
                   next_poll_at = now() + make_interval(secs => ${row.interval_s + 5}), updated_at = now() where id = ${row.id}`;
        return 'PENDING';
      case 'access_denied':
        await sql`update world_attempts set status = 'DENIED', reason = 'access_denied', updated_at = now() where id = ${row.id}`;
        return 'DENIED';
      case 'expired_token':
        await sql`update world_attempts set status = 'EXPIRED', reason = 'expired_token', updated_at = now() where id = ${row.id}`;
        return 'EXPIRED';
      default:
        await sql`update world_attempts set status = 'FAILED', reason = ${j.error ?? `http_${res.status}`}, updated_at = now() where id = ${row.id}`;
        return 'FAILED';
    }
  }

  // Validate the ID token in the backend.
  let claims: { iss?: string; sub?: string; auth_time?: number; acr?: string; amr?: unknown };
  try {
    const verified = await jwtVerify(j.id_token, jwks!, { issuer: d.issuer, audience: env.WORLD_CLIENT_ID });
    claims = verified.payload as typeof claims;
  } catch (err) {
    await sql`update world_attempts set status = 'FAILED', reason = ${`invalid_id_token: ${(err as Error).message}`}, updated_at = now() where id = ${row.id}`;
    return 'FAILED';
  }
  const nowS = Date.now() / 1000;
  const startedS = row.started_at.getTime() / 1000;
  let reason: string | null = null;
  if (typeof claims.auth_time !== 'number') reason = 'missing_auth_time';
  else if (claims.auth_time < startedS - 5) reason = 'auth_time_before_attempt';
  else if (nowS - claims.auth_time > env.WORLD_FRESH_SECONDS) reason = 'auth_not_fresh';
  else if (!claims.sub || !claims.iss) reason = 'missing_sub';
  if (reason) {
    await sql`update world_attempts set status = 'FAILED', reason = ${reason}, updated_at = now() where id = ${row.id}`;
    return 'FAILED';
  }
  if (row.expected_sub && claims.sub !== row.expected_sub) {
    await sql`update world_attempts set status = 'DENIED', reason = 'wrong_human', updated_at = now() where id = ${row.id}`;
    return 'DENIED';
  }
  await sql`
    update world_attempts set status = 'APPROVED', result_iss = ${claims.iss!}, result_sub = ${claims.sub!},
           auth_time = ${claims.auth_time!}, acr = ${claims.acr ?? null}, amr = ${sql.json((claims.amr ?? null) as never)},
           updated_at = now()
     where id = ${row.id}`;
  return 'APPROVED';
}

type Handler = (row: AttemptRow) => Promise<void>;
const onApproved = new Map<AttemptRow['kind'], Handler>();
const onFinishedNegative = new Map<AttemptRow['kind'], Handler>();

export function onWorldApproved(kind: AttemptRow['kind'], h: Handler) {
  onApproved.set(kind, h);
}
export function onWorldNotApproved(kind: AttemptRow['kind'], h: Handler) {
  onFinishedNegative.set(kind, h);
}

/** Background worker: polls due attempts and runs the kind-specific handler exactly once. */
export function startWorldWorker(log: { error: (o: object, m: string) => void }) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const due = await sql<AttemptRow[]>`select * from world_attempts where status = 'PENDING' and next_poll_at <= now() order by next_poll_at limit 20`;
      for (const row of due) {
        const outcome = await pollOnce(row);
        if (outcome === 'PENDING') continue;
        const [fresh] = await sql<AttemptRow[]>`select * from world_attempts where id = ${row.id}`;
        const handler = outcome === 'APPROVED' ? onApproved.get(row.kind) : onFinishedNegative.get(row.kind);
        if (!handler || !fresh) continue;
        try {
          await handler(fresh);
        } catch (err) {
          log.error({ err, attempt: row.id }, 'world handler failed');
          await sql`update world_attempts set status = 'FAILED', reason = ${`handler: ${(err as Error).message}`}, updated_at = now() where id = ${row.id}`;
        }
      }
    } catch (err) {
      log.error({ err }, 'world worker tick failed');
    } finally {
      busy = false;
    }
  }, 1000);
}
```

**File: `services/api/src/humans.ts`**

```ts
import { ecdsaKeyToHex, humanHashOf, publishHcs } from '@forkos/shared';
import { AccountCreateTransaction, Hbar, PrivateKey, TransferTransaction } from '@hiero-ledger/sdk';
import { env, PROVIDER_IDS } from './config';
import { hedera } from './clients';
import { encrypt } from './crypto';
import { sql, type HumanRow } from './db';

/** Finds or creates the human for (iss, sub): budget account funded with FUSD, default policy. */
export async function ensureHuman(iss: string, sub: string): Promise<HumanRow> {
  const humanHash = humanHashOf(iss, sub, env.HUMAN_SALT);
  const [existing] = await sql<HumanRow[]>`select * from humans where human_hash = ${humanHash}`;
  if (existing) return existing;

  const key = PrivateKey.generateECDSA();
  const created = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(new Hbar(env.HUMAN_HBAR_FUND))
    .setMaxAutomaticTokenAssociations(-1)
    .execute(hedera);
  const accountId = (await created.getReceipt(hedera)).accountId!.toString();

  const fund = await new TransferTransaction()
    .addTokenTransfer(env.PAY_ASSET, env.OPERATOR_ID, -BigInt(env.HUMAN_FUSD_FUND))
    .addTokenTransfer(env.PAY_ASSET, accountId, BigInt(env.HUMAN_FUSD_FUND))
    .execute(hedera);
  await fund.getReceipt(hedera);

  const [row] = await sql<HumanRow[]>`
    insert into humans (human_hash, iss, sub, budget_account_id, budget_key_enc)
    values (${humanHash}, ${iss}, ${sub}, ${accountId}, ${encrypt(ecdsaKeyToHex(key))})
    on conflict (human_hash) do nothing
    returning *`;
  await sql`
    insert into policies (human_hash, cap_per_payment, daily_cap, allowlist)
    values (${humanHash}, ${env.POLICY_DEFAULT_CAP}, ${env.POLICY_DEFAULT_DAILY}, ${PROVIDER_IDS})
    on conflict (human_hash) do nothing`;
  return row ?? (await sql<HumanRow[]>`select * from humans where human_hash = ${humanHash}`)[0]!;
}

/** Publishes an APPROVAL record (no PII: humanHash + action digest only). */
export async function publishApproval(human: string, kind: 'LINK' | 'REVOKE' | 'OVERCAP', digest: string) {
  return publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'APPROVAL', human, kind, digest });
}
```

> With `PAY_ASSET=0.0.0` (HBAR fallback) replace the FUSD funding with an HBAR transfer of the same value.

**File: `services/api/src/routes/owner.ts`**

```ts
import { ApiError, formatUnits } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requireOwner } from '../auth';
import { env } from '../config';
import { mirror } from '../clients';
import { decrypt, encrypt, hashToken, newToken } from '../crypto';
import { sql, type AgentRow, type AttemptRow } from '../db';
import { emit } from '../events';
import { ensureHuman } from '../humans';
import { attemptPublic, onWorldApproved, startDeviceFlow } from '../world';
import { policyView } from '../policy';

export function registerOwnerRoutes(app: FastifyInstance) {
  // LOGIN approved → ensure human + session; token stored sealed in the attempt until the browser fetches it once.
  onWorldApproved('LOGIN', async (row: AttemptRow) => {
    const human = await ensureHuman(row.result_iss!, row.result_sub!);
    const token = newToken('fos');
    await sql`insert into owner_sessions (token_hash, human_hash, expires_at)
              values (${hashToken(token)}, ${human.human_hash}, now() + interval '24 hours')`;
    await sql`update world_attempts set human_hash = ${human.human_hash},
               context = context || ${sql.json({ sessionTokenEnc: encrypt(token) } as never)}, updated_at = now()
               where id = ${row.id}`;
    await emit('approval.resolved', { approvalId: row.id, kind: 'LOGIN', status: 'APPROVED' });
  });

  app.post('/v1/owner/login/start', async () => attemptPublic(await startDeviceFlow('LOGIN')));

  app.get<{ Params: { attemptId: string } }>('/v1/owner/login/:attemptId', async (req) => {
    const [row] = await sql<AttemptRow[]>`select * from world_attempts where id = ${req.params.attemptId} and kind = 'LOGIN'`;
    if (!row) throw new ApiError('NOT_FOUND', 'unknown attempt');
    if (row.status !== 'APPROVED') return { status: row.status, reason: row.reason };
    const sealed = row.context.sessionTokenEnc as string | undefined;
    if (!sealed || !row.human_hash) return { status: 'PENDING' }; // handler still running
    // Hand the token out exactly once.
    await sql`update world_attempts set context = context - 'sessionTokenEnc', updated_at = now() where id = ${row.id}`;
    const [h] = await sql<{ budget_account_id: string }[]>`select budget_account_id from humans where human_hash = ${row.human_hash}`;
    return { status: 'APPROVED', token: decrypt(sealed), human: { humanHash: row.human_hash, budgetAccountId: h!.budget_account_id } };
  });

  app.get('/v1/me', async (req) => {
    const human = await requireOwner(req);
    const [hbar, fusd] = await Promise.all([
      mirror.hbarBalance(human.budget_account_id),
      env.PAY_ASSET === '0.0.0' ? Promise.resolve(0n) : mirror.tokenBalance(human.budget_account_id, env.PAY_ASSET),
    ]);
    const agents = await sql<AgentRow[]>`select * from agents where human_hash = ${human.human_hash} order by linked_at`;
    const [pairing] = await sql<{ code: string; expires_at: Date }[]>`
      select code, expires_at from pairings where human_hash = ${human.human_hash} and used_at is null and expires_at > now()
      order by expires_at desc limit 1`;
    return {
      humanHash: human.human_hash,
      budgetAccountId: human.budget_account_id,
      balance: {
        asset: env.PAY_ASSET,
        amount: fusd.toString(),
        display: formatUnits(fusd, env.PAY_ASSET_DECIMALS),
        hbar: formatUnits(hbar, 8),
      },
      policy: await policyView(human.human_hash),
      agents: agents.map((a) => ({
        agentAddr: a.agent_addr,
        label: a.label,
        accountId: a.account_id,
        epoch: a.epoch,
        status: a.status,
        linkedAt: a.linked_at,
        arkivKey: a.arkiv_key,
      })),
      pairing: pairing ? { code: pairing.code, expiresAt: pairing.expires_at } : null,
      world: { subStable: env.WORLD_SUB_STABLE },
    };
  });

  app.post('/v1/pairings', async (req) => {
    const human = await requireOwner(req);
    const { label } = z.object({ label: z.string().min(1).max(40) }).parse(req.body ?? {});
    const code = randomBytes(4).toString('hex').toUpperCase(); // 8 chars, shown on the dashboard
    const [row] = await sql<{ code: string; expires_at: Date }[]>`
      insert into pairings (code, human_hash, label, expires_at) values (${code}, ${human.human_hash}, ${label}, now() + interval '15 minutes')
      returning code, expires_at`;
    return { code: row!.code, expiresAt: row!.expires_at };
  });
}
```

**File: `services/api/src/policy.ts`** (minimal now; P28 completes it)

```ts
import { sql } from './db';

export async function policyView(humanHash: string) {
  const [p] = await sql<{ cap_per_payment: string; daily_cap: string; allowlist: string[] }[]>`
    select cap_per_payment, daily_cap, allowlist from policies where human_hash = ${humanHash}`;
  const [s] = await sql<{ spent: string | null }[]>`
    select coalesce(sum(amount), 0)::text as spent from intents
     where human_hash = ${humanHash} and created_at >= date_trunc('day', now())
       and status in ('CREATED','SENT','PAYMENT_UNKNOWN','PAID','DONE')`;
  return {
    capPerPayment: p?.cap_per_payment ?? '0',
    dailyCap: p?.daily_cap ?? '0',
    allowlist: p?.allowlist ?? [],
    spentToday: s?.spent ?? '0',
  };
}
```

Register in **`services/api/src/index.ts`** (before `app.listen`):

```ts
import { registerOwnerRoutes } from './routes/owner';
import { startWorldWorker } from './world';
// …
registerOwnerRoutes(app);
startWorldWorker(app.log);
```

**Commands**

```bash
pnpm dev:api
curl -s -XPOST localhost:4000/v1/owner/login/start
# approve verificationUriComplete on a phone, then poll:
curl -s localhost:4000/v1/owner/login/<attemptId>
curl -s localhost:4000/v1/me -H "authorization: Bearer <token>"
```

**Exit checks**

- [ ] Start returns `attemptId`, `userCode`, `verificationUriComplete`
- [ ] After phone approval, poll returns `status: APPROVED` + `token` (fos_…) **once**; the second poll returns `PENDING`-free `APPROVED` without a token (the token is gone) — note: the second call returns `{status:"PENDING"}` by design because the sealed token was consumed; the dashboard keeps the first
- [ ] `/v1/me` shows a new `budgetAccountId` with **20 FUSD** (HashScan confirms) and the default policy
- [ ] Cancel on the phone → `status: DENIED, reason: access_denied`; wait 20 min or use an old code → `EXPIRED`
- [ ] **Sub stability (decides `WORLD_SUB_STABLE`):** log in twice with the same test identity; same `humanHash` both times → `true`; different → set `false`
- [ ] `world_attempts` rows never contain a plaintext device code (`device_code_enc` is `iv.tag.cipher`)
- [ ] Note "time to first success" in `docs/world-debrief.md`

**Commit:** `feat(api): world device flow worker with backend id_token validation + owner sign-in and budget accounts`

---

### Phase P25 — API: link an agent (World-protected action #1)

**Goal:** an agent (any platform) links to a human after a fresh World authentication. The API then: creates
the agent's **Hedera account from the agent's own public key** (so only the agent can submit its `CLAIM`s),
funds its Arkiv wallet with a little tGLM, writes the **Arkiv `AgentLink`**, publishes **HCS `LINK`** and
`APPROVAL`, and issues an agent token. **Time:** 75 min. **Depends:** P24.

Which human does the agent link to?

| Mode | How the human is chosen |
|---|---|
| `WORLD_SUB_STABLE=true` | the human whose World `sub` approved the link → **every agent linked by the same person lands in the same budget and dedupe scope, on any platform** (the cross-platform story) |
| `WORLD_SUB_STABLE=false` | the owner creates a pairing code on the dashboard; the agent sends it; after a successful fresh World authentication the agent links to the pairing's owner |

**File: `services/api/src/agents.ts`**

```ts
import { ApiError, ExpirationTime, AgentLinkSchema, digestOf, getAgentLink, publishHcs, u64 } from '@forkos/shared';
import { AccountCreateTransaction, Hbar, PublicKey } from '@hiero-ledger/sdk';
import { env } from './config';
import { API_ARKIV_ADDRESS, arkivApi, arkivPub, hedera } from './clients';
import { encrypt, hashToken, newToken } from './crypto';
import { sql, type AgentRow } from './db';
import { emit } from './events';
import { publishApproval } from './humans';

/** The ECDSA public key must derive the claimed EVM address (one key = Hedera account + Arkiv wallet). */
export function assertKeyMatchesAddress(publicKeyHex: string, agentAddr: string) {
  let derived: string;
  try {
    derived = PublicKey.fromStringECDSA(publicKeyHex.replace(/^0x/, '')).toEvmAddress().toLowerCase().replace(/^0x/, '');
  } catch {
    throw new ApiError('BAD_REQUEST', 'publicKeyHex is not a valid ECDSA public key');
  }
  if (`0x${derived}` !== agentAddr.toLowerCase()) throw new ApiError('BAD_REQUEST', 'publicKeyHex does not match agentAddr');
}

export async function upsertAgentLinkEntity(row: { human: string; agent: string; status: 'ACTIVE' | 'REVOKED'; epoch: number; acct: string; label: string }) {
  const values = { human: row.human, agent: row.agent, status: row.status, epoch: u64(row.epoch), acct: row.acct, label: row.label };
  const existing = await getAgentLink(arkivPub, row.agent, API_ARKIV_ADDRESS);
  if (existing) {
    const key = existing.key as `0x${string}`;
    await arkivApi.patchEntity(AgentLinkSchema, key, { set: values });
    await arkivApi.extendEntity({ entityKey: key, expiration: ExpirationTime.atDate(new Date(Date.now() + 30 * 86_400_000)) });
    return existing.key;
  }
  const created = await arkivApi.createEntity(AgentLinkSchema, values, { expiration: ExpirationTime.fromDays(30) });
  return created.entityKey;
}

/** Links (or re-links) an agent to a human. Returns the agent token (shown once). */
export async function linkAgent(input: { humanHash: string; agentAddr: string; publicKeyHex: string; label: string }) {
  const agentAddr = input.agentAddr.toLowerCase();
  const [prev] = await sql<AgentRow[]>`select * from agents where agent_addr = ${agentAddr}`;
  if (prev && prev.human_hash !== input.humanHash) throw new ApiError('FORBIDDEN', 'agent already belongs to another human');
  const epoch = prev ? prev.epoch + 1 : 1;

  // 1. Hedera account owned by the agent's own key (re-used on re-link).
  let accountId = prev?.account_id;
  if (!accountId) {
    const resp = await new AccountCreateTransaction()
      .setKeyWithoutAlias(PublicKey.fromStringECDSA(input.publicKeyHex.replace(/^0x/, '')))
      .setInitialBalance(new Hbar(env.AGENT_HBAR_FUND))
      .execute(hedera);
    accountId = (await resp.getReceipt(hedera)).accountId!.toString();
  }

  // 2. A little tGLM so the agent can write its own Arkiv claims.
  if (!prev) {
    await arkivApi.sendTransaction({ to: agentAddr as `0x${string}`, value: BigInt(env.AGENT_ARKIV_FUND_WEI) } as never);
  }

  // 3. HCS LINK (ordered, public) then Arkiv AgentLink (live state providers read).
  const { seq } = await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'LINK', human: input.humanHash, agent: agentAddr, acct: accountId, epoch });
  const arkivKey = await upsertAgentLinkEntity({ human: input.humanHash, agent: agentAddr, status: 'ACTIVE', epoch, acct: accountId, label: input.label });
  await publishApproval(input.humanHash, 'LINK', digestOf({ kind: 'LINK', human: input.humanHash, agent: agentAddr, epoch }));

  // 4. DB row + token.
  await sql`
    insert into agents (agent_addr, human_hash, label, account_id, public_key_hex, epoch, status, arkiv_key, link_seq)
    values (${agentAddr}, ${input.humanHash}, ${input.label}, ${accountId}, ${input.publicKeyHex}, ${epoch}, 'ACTIVE', ${arkivKey}, ${seq})
    on conflict (agent_addr) do update set epoch = ${epoch}, status = 'ACTIVE', label = ${input.label}, arkiv_key = ${arkivKey},
      link_seq = ${seq}, linked_at = now(), revoked_at = null`;
  await sql`update agent_tokens set revoked_at = now() where agent_addr = ${agentAddr} and revoked_at is null`;
  const token = newToken('fat');
  await sql`insert into agent_tokens (token_hash, agent_addr, epoch) values (${hashToken(token)}, ${agentAddr}, ${epoch})`;

  await emit('agent.linked', { humanHash: input.humanHash, agentAddr, label: input.label, accountId, epoch });
  return { token, sealed: encrypt(token), accountId, epoch, arkivKey };
}
```

> `arkivApi.sendTransaction` is viem's standard wallet action (the Arkiv wallet client extends viem's). The
> `as never` cast only silences viem's strict chain/kzg generics; the call is a plain value transfer.

**File: `services/api/src/routes/agents.ts`**

```ts
import { ApiError, zEvmAddr } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertKeyMatchesAddress, linkAgent } from '../agents';
import { requireAgent, requireOwner } from '../auth';
import { env } from '../config';
import { decrypt } from '../crypto';
import { sql, type AgentRow, type AttemptRow } from '../db';
import { ensureHuman } from '../humans';
import { attemptPublic, onWorldApproved, startDeviceFlow } from '../world';

const LinkStart = z.object({
  agentAddr: zEvmAddr,
  publicKeyHex: z.string().regex(/^(0x)?[0-9a-fA-F]{66}$|^(0x)?[0-9a-fA-F]{130}$/),
  label: z.string().min(1).max(40),
  pairingCode: z.string().min(4).max(16).optional(),
});

export function registerAgentRoutes(app: FastifyInstance) {
  onWorldApproved('LINK', async (row: AttemptRow) => {
    const ctx = row.context as { agentAddr: string; publicKeyHex: string; label: string; pairingCode?: string };
    let humanHash: string;
    if (env.WORLD_SUB_STABLE) {
      humanHash = (await ensureHuman(row.result_iss!, row.result_sub!)).human_hash;
    } else {
      // pairing mode: fresh World auth succeeded; bind to the owner who created the pairing code
      const [p] = await sql<{ human_hash: string }[]>`
        update pairings set used_at = now() where code = ${ctx.pairingCode ?? ''} and used_at is null and expires_at > now()
        returning human_hash`;
      if (!p) throw new Error('pairing code invalid, used or expired');
      humanHash = p.human_hash;
    }
    const linked = await linkAgent({ humanHash, agentAddr: ctx.agentAddr, publicKeyHex: ctx.publicKeyHex, label: ctx.label });
    await sql`update world_attempts set human_hash = ${humanHash},
               context = context || ${sql.json({ agentTokenEnc: linked.sealed, accountId: linked.accountId, epoch: linked.epoch } as never)},
               updated_at = now() where id = ${row.id}`;
  });

  app.post('/v1/agents/link/start', async (req) => {
    const body = LinkStart.parse(req.body);
    assertKeyMatchesAddress(body.publicKeyHex, body.agentAddr);
    if (!env.WORLD_SUB_STABLE) {
      if (!body.pairingCode) throw new ApiError('BAD_REQUEST', 'pairingCode required (create one on the dashboard)');
      const [p] = await sql`select 1 from pairings where code = ${body.pairingCode} and used_at is null and expires_at > now()`;
      if (!p) throw new ApiError('BAD_REQUEST', 'pairing code invalid, used or expired');
    }
    const attempt = await startDeviceFlow('LINK', { context: body });
    const pub = attemptPublic(attempt);
    return { linkId: pub.attemptId, ...pub };
  });

  app.get<{ Params: { linkId: string } }>('/v1/agents/link/:linkId', async (req) => {
    const [row] = await sql<AttemptRow[]>`select * from world_attempts where id = ${req.params.linkId} and kind = 'LINK'`;
    if (!row) throw new ApiError('NOT_FOUND', 'unknown link attempt');
    if (row.status !== 'APPROVED') return { status: row.status, reason: row.reason };
    const ctx = row.context as { agentTokenEnc?: string; accountId?: string; epoch?: number; agentAddr: string };
    if (!ctx.agentTokenEnc) return { status: 'PENDING' };
    await sql`update world_attempts set context = context - 'agentTokenEnc', updated_at = now() where id = ${row.id}`;
    return {
      status: 'LINKED',
      agentToken: decrypt(ctx.agentTokenEnc),
      agent: { agentAddr: ctx.agentAddr, accountId: ctx.accountId, epoch: ctx.epoch, humanHash: row.human_hash },
    };
  });

  app.get('/v1/agents', async (req) => {
    const human = await requireOwner(req);
    const rows = await sql<AgentRow[]>`select * from agents where human_hash = ${human.human_hash} order by linked_at`;
    return {
      agents: rows.map((a) => ({
        agentAddr: a.agent_addr,
        label: a.label,
        accountId: a.account_id,
        epoch: a.epoch,
        status: a.status,
        linkedAt: a.linked_at,
        arkivKey: a.arkiv_key,
      })),
    };
  });

  app.get('/v1/me/agent', async (req) => {
    const a = await requireAgent(req);
    return { agentAddr: a.agent_addr, humanHash: a.human_hash, accountId: a.account_id, epoch: a.epoch, status: a.status, label: a.label };
  });

}
```

Register in **`services/api/src/index.ts`**: `import { registerAgentRoutes } from './routes/agents';` and
`registerAgentRoutes(app);`.

**File: `apps/agents/src/link.ts`** — links one agent from the terminal and stores its key + token.

```ts
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

const api = new ForkosApi(process.env.FORKOS_API_URL ?? 'http://localhost:4000');
const start = await api.linkStart({ agentAddr: id.address, publicKeyHex: id.publicKeyHex, label, pairingCode });
console.log(`\nApprove on your phone (World ID):\n  ${start.verificationUriComplete ?? start.verificationUri}\n  code: ${start.userCode}\n`);
const linked = await api.linkWait(start.linkId);
store[label] = { key, token: linked.agentToken, accountId: linked.agent.accountId };
mkdirSync(join(FILE, '..'), { recursive: true });
writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
console.log('linked', { label, agent: id.address, accountId: linked.agent.accountId, epoch: linked.agent.epoch });
```

> `agentIdentity` and `ForkosApi` come from `@forkos/agent-kit` (P35). Build P35's `identity.ts` and `api.ts`
> now if you want to run this before P35 — they have no other dependencies. Add `viem` to
> `apps/agents/package.json` dependencies (`"viem": "^2.40.0"`).

**Exit checks** (after P35's identity/api files exist)

- [ ] `pnpm --filter @forkos/agents link "Claude Desktop"` prints a World link; after approval prints `linked … epoch: 1`
- [ ] HashScan shows the agent's new account; Arkiv explorer shows an `AgentLink` owned by `API_ARKIV_ADDRESS`, status `ACTIVE`
- [ ] Mirror topic has `LINK` and `APPROVAL` from `OPERATOR_ID`
- [ ] Linking a **second** label with the same World identity → same `humanHash` (sub-stable mode)
- [ ] `publicKeyHex` of a different key → `400 publicKeyHex does not match agentAddr`
- [ ] Cancel on the phone → `GET /v1/agents/link/:id` = `DENIED`, no account created (check HashScan/DB)

**Commit:** `feat(api): World-protected agent linking — agent-keyed hedera account, arkiv AgentLink, HCS LINK`

---

### Phase P26 — API: fire / replace an agent (World-protected action #2)

**Goal:** the owner revokes an agent. Requires a fresh World authentication **by the same human** (pinned
`sub`), bound to an approval with a digest of the exact action. On success: epoch bump, tokens revoked, HCS
`REVOKE`, Arkiv `AgentLink` → `REVOKED`. Providers immediately refuse the old agent (fence F5/F6). **Time:** 50 min.
**Depends:** P25.

**File: `services/api/src/approvals.ts`**

```ts
import { APPROVAL_TTL_S, ApiError, digestOf } from '@forkos/shared';
import { newId } from './crypto';
import { sql, type ApprovalRow } from './db';
import { emit } from './events';
import { attemptPublic, startDeviceFlow } from './world';

/** Creates a PENDING approval bound to `action` (digest) and starts the World step-up for it. */
export async function createApproval(
  humanHash: string,
  sub: string,
  kind: 'REVOKE' | 'OVERCAP',
  action: Record<string, unknown>,
) {
  const digest = digestOf(action);
  const id = newId('ap');
  const attempt = await startDeviceFlow(kind, { expectedSub: sub, humanHash, context: { approvalId: id } });
  await sql`
    insert into approvals (id, human_hash, kind, status, action, digest, world_attempt_id, expires_at)
    values (${id}, ${humanHash}, ${kind}, 'PENDING', ${sql.json(action as never)}, ${digest}, ${attempt.id},
            now() + make_interval(secs => ${APPROVAL_TTL_S}))`;
  const pub = attemptPublic(attempt);
  await emit('approval.pending', {
    approvalId: id,
    kind,
    humanHash,
    action,
    userCode: pub.userCode,
    verificationUriComplete: pub.verificationUriComplete,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_S * 1000).toISOString(),
  });
  return { approvalId: id, digest, ...pub };
}

/**
 * Atomically consumes an APPROVED approval for exactly this action. Throws if missing, expired, used,
 * or bound to a different action (APPROVAL_MISMATCH). Must be called inside the caller's transaction.
 */
export async function consumeApproval(tx: typeof sql, approvalId: string, action: Record<string, unknown>): Promise<ApprovalRow> {
  const [a] = await tx<ApprovalRow[]>`select * from approvals where id = ${approvalId} for update`;
  if (!a) throw new ApiError('NOT_FOUND', 'unknown approval');
  if (a.digest !== digestOf(action)) throw new ApiError('APPROVAL_MISMATCH', 'approval was given for a different action');
  if (a.status === 'USED') throw new ApiError('APPROVAL_MISMATCH', 'approval already used');
  if (a.status !== 'APPROVED') throw new ApiError('FORBIDDEN', `approval is ${a.status}`);
  if (a.expires_at.getTime() < Date.now()) throw new ApiError('APPROVAL_EXPIRED', 'approval expired');
  const [used] = await tx<ApprovalRow[]>`update approvals set status = 'USED', used_at = now() where id = ${approvalId} returning *`;
  return used!;
}

export async function setApprovalStatus(approvalId: string, status: 'APPROVED' | 'DENIED' | 'EXPIRED') {
  const [a] = await sql<ApprovalRow[]>`update approvals set status = ${status} where id = ${approvalId} and status = 'PENDING' returning *`;
  if (a) await emit('approval.resolved', { approvalId, kind: a.kind, status });
  return a ?? null;
}
```

**File: `services/api/src/routes/agents.ts`** (final version — replaces the P25 file)

```ts
import { ApiError, publishHcs, zEvmAddr } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertKeyMatchesAddress, linkAgent, upsertAgentLinkEntity } from '../agents';
import { consumeApproval, createApproval, setApprovalStatus } from '../approvals';
import { requireAgent, requireOwner } from '../auth';
import { hedera } from '../clients';
import { env } from '../config';
import { decrypt } from '../crypto';
import { sql, type AgentRow, type ApprovalRow, type AttemptRow } from '../db';
import { emit } from '../events';
import { ensureHuman, publishApproval } from '../humans';
import { attemptPublic, onWorldApproved, onWorldNotApproved, startDeviceFlow } from '../world';

const LinkStart = z.object({
  agentAddr: zEvmAddr,
  publicKeyHex: z.string().regex(/^(0x)?[0-9a-fA-F]{66}$|^(0x)?[0-9a-fA-F]{130}$/),
  label: z.string().min(1).max(40),
  pairingCode: z.string().min(4).max(16).optional(),
});

export function registerAgentRoutes(app: FastifyInstance) {
  // ── linking (P25) ──
  onWorldApproved('LINK', async (row: AttemptRow) => {
    const ctx = row.context as { agentAddr: string; publicKeyHex: string; label: string; pairingCode?: string };
    let humanHash: string;
    if (env.WORLD_SUB_STABLE) {
      humanHash = (await ensureHuman(row.result_iss!, row.result_sub!)).human_hash;
    } else {
      const [p] = await sql<{ human_hash: string }[]>`
        update pairings set used_at = now() where code = ${ctx.pairingCode ?? ''} and used_at is null and expires_at > now()
        returning human_hash`;
      if (!p) throw new Error('pairing code invalid, used or expired');
      humanHash = p.human_hash;
    }
    const linked = await linkAgent({ humanHash, agentAddr: ctx.agentAddr, publicKeyHex: ctx.publicKeyHex, label: ctx.label });
    await sql`update world_attempts set human_hash = ${humanHash},
               context = context || ${sql.json({ agentTokenEnc: linked.sealed, accountId: linked.accountId, epoch: linked.epoch } as never)},
               updated_at = now() where id = ${row.id}`;
  });

  app.post('/v1/agents/link/start', async (req) => {
    const body = LinkStart.parse(req.body);
    assertKeyMatchesAddress(body.publicKeyHex, body.agentAddr);
    if (!env.WORLD_SUB_STABLE) {
      if (!body.pairingCode) throw new ApiError('BAD_REQUEST', 'pairingCode required (create one on the dashboard)');
      const [p] = await sql`select 1 from pairings where code = ${body.pairingCode} and used_at is null and expires_at > now()`;
      if (!p) throw new ApiError('BAD_REQUEST', 'pairing code invalid, used or expired');
    }
    const attempt = await startDeviceFlow('LINK', { context: body });
    const pub = attemptPublic(attempt);
    return { linkId: pub.attemptId, ...pub };
  });

  app.get<{ Params: { linkId: string } }>('/v1/agents/link/:linkId', async (req) => {
    const [row] = await sql<AttemptRow[]>`select * from world_attempts where id = ${req.params.linkId} and kind = 'LINK'`;
    if (!row) throw new ApiError('NOT_FOUND', 'unknown link attempt');
    if (row.status !== 'APPROVED') return { status: row.status, reason: row.reason };
    const ctx = row.context as { agentTokenEnc?: string; accountId?: string; epoch?: number; agentAddr: string };
    if (!ctx.agentTokenEnc) return { status: 'PENDING' };
    await sql`update world_attempts set context = context - 'agentTokenEnc', updated_at = now() where id = ${row.id}`;
    return {
      status: 'LINKED',
      agentToken: decrypt(ctx.agentTokenEnc),
      agent: { agentAddr: ctx.agentAddr, accountId: ctx.accountId, epoch: ctx.epoch, humanHash: row.human_hash },
    };
  });

  app.get('/v1/agents', async (req) => {
    const human = await requireOwner(req);
    const rows = await sql<AgentRow[]>`select * from agents where human_hash = ${human.human_hash} order by linked_at`;
    return {
      agents: rows.map((a) => ({
        agentAddr: a.agent_addr,
        label: a.label,
        accountId: a.account_id,
        epoch: a.epoch,
        status: a.status,
        linkedAt: a.linked_at,
        arkivKey: a.arkiv_key,
      })),
    };
  });

  app.get('/v1/me/agent', async (req) => {
    const a = await requireAgent(req);
    return { agentAddr: a.agent_addr, humanHash: a.human_hash, accountId: a.account_id, epoch: a.epoch, status: a.status, label: a.label };
  });

  // ── revoke / replace (P26) ──
  onWorldApproved('REVOKE', async (row: AttemptRow) => {
    const approvalId = (row.context as { approvalId: string }).approvalId;
    const approval = await setApprovalStatus(approvalId, 'APPROVED');
    if (approval) await executeRevoke(approval);
  });
  onWorldNotApproved('REVOKE', async (row: AttemptRow) => {
    const approvalId = (row.context as { approvalId: string }).approvalId;
    await setApprovalStatus(approvalId, row.status === 'EXPIRED' ? 'EXPIRED' : 'DENIED');
  });

  app.post<{ Params: { agentAddr: string } }>('/v1/agents/:agentAddr/revoke/start', async (req) => {
    const human = await requireOwner(req);
    const agentAddr = req.params.agentAddr.toLowerCase();
    const [a] = await sql<AgentRow[]>`select * from agents where agent_addr = ${agentAddr} and human_hash = ${human.human_hash}`;
    if (!a) throw new ApiError('NOT_FOUND', 'agent not found for this owner');
    if (a.status !== 'ACTIVE') throw new ApiError('BAD_REQUEST', 'agent already revoked');
    const action = { kind: 'REVOKE', human: human.human_hash, agent: agentAddr, fromEpoch: a.epoch };
    return createApproval(human.human_hash, human.sub, 'REVOKE', action);
  });

  app.get<{ Params: { approvalId: string } }>('/v1/approvals/:approvalId', async (req) => {
    const human = await requireOwner(req);
    const [a] = await sql<ApprovalRow[]>`select * from approvals where id = ${req.params.approvalId} and human_hash = ${human.human_hash}`;
    if (!a) throw new ApiError('NOT_FOUND', 'unknown approval');
    return { approvalId: a.id, kind: a.kind, status: a.status, action: a.action, digest: a.digest, expiresAt: a.expires_at };
  });

  app.post<{ Params: { approvalId: string } }>('/v1/approvals/:approvalId/cancel', async (req) => {
    const human = await requireOwner(req);
    const [a] = await sql<ApprovalRow[]>`select * from approvals where id = ${req.params.approvalId} and human_hash = ${human.human_hash}`;
    if (!a) throw new ApiError('NOT_FOUND', 'unknown approval');
    await setApprovalStatus(a.id, 'DENIED');
    return { status: 'DENIED' };
  });
}

async function executeRevoke(approval: ApprovalRow) {
  const action = approval.action as { kind: 'REVOKE'; human: string; agent: string; fromEpoch: number };
  const newEpoch = action.fromEpoch + 1;
  const agent = await sql.begin(async (tx) => {
    await consumeApproval(tx as unknown as typeof sql, approval.id, action);
    const [a] = await tx<AgentRow[]>`select * from agents where agent_addr = ${action.agent} for update`;
    if (!a || a.epoch !== action.fromEpoch || a.status !== 'ACTIVE') throw new ApiError('APPROVAL_MISMATCH', 'agent changed since approval');
    await tx`update agents set status = 'REVOKED', epoch = ${newEpoch}, revoked_at = now() where agent_addr = ${action.agent}`;
    await tx`update agent_tokens set revoked_at = now() where agent_addr = ${action.agent} and revoked_at is null`;
    return a;
  });
  await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'REVOKE', human: action.human, agent: action.agent, epoch: newEpoch });
  await upsertAgentLinkEntity({ human: action.human, agent: action.agent, status: 'REVOKED', epoch: newEpoch, acct: agent.account_id, label: agent.label });
  await publishApproval(action.human, 'REVOKE', approval.digest);
  await emit('agent.revoked', { humanHash: action.human, agentAddr: action.agent, epoch: newEpoch });
}
```

Re-linking a revoked agent later is the "replace" path: `POST /v1/agents/link/start` with the same address →
World approval → `linkAgent` sets `epoch = old + 1`, `ACTIVE`, new token. Old tokens and old-epoch claims stay
dead.

**Exit checks**

- [ ] Revoke start (owner token) → `approvalId`, `userCode`; dashboard SSE shows `approval.pending`
- [ ] Approve with **the same** World identity → approval `USED`, agent `REVOKED`, `epoch` +1; HCS `REVOKE`; Arkiv `AgentLink` `REVOKED`
- [ ] The revoked agent's token now gets `409 STALE_AUTHORITY` on `/v1/me/agent`
- [ ] Approve with a **different** World identity → `DENIED` (`access_denied` from World because `sub` is pinned, or `wrong_human` from our check) and the agent stays `ACTIVE`
- [ ] Cancel via `POST /v1/approvals/:id/cancel` → `DENIED`; approving on the phone afterwards changes nothing (approval no longer `PENDING`)

**Commit:** `feat(api): World-protected agent revoke — pinned-sub step-up, digest-bound approval, epoch fencing`

---

### Phase P27 — World denied paths: tests and evidence

**Goal:** the World prize explicitly requires a denied/expired/cancelled path. We prove five, with automated
tests for the parts that do not need a phone and a scripted manual check for the rest. **Time:** 40 min.
**Depends:** P26.

**File: `services/api/test/approvals.test.ts`** (pure logic, no DB: tests the digest binding rule)

```ts
import { digestOf } from '@forkos/shared';
import { describe, expect, it } from 'vitest';

describe('approval digest binding', () => {
  const action = { kind: 'OVERCAP', human: 'a'.repeat(64), jobKey: 'b'.repeat(64), round: 0, providerId: 'scribe-premium', payTo: '0.0.9', amount: '2000000', asset: '0.0.7' };

  it('is stable under key order', () => {
    const shuffled = { amount: '2000000', asset: '0.0.7', round: 0, kind: 'OVERCAP', payTo: '0.0.9', providerId: 'scribe-premium', jobKey: 'b'.repeat(64), human: 'a'.repeat(64) };
    expect(digestOf(shuffled)).toBe(digestOf(action));
  });

  it('changes when any field changes (a replayed approval cannot authorize something else)', () => {
    expect(digestOf({ ...action, amount: '2000001' })).not.toBe(digestOf(action));
    expect(digestOf({ ...action, payTo: '0.0.10' })).not.toBe(digestOf(action));
    expect(digestOf({ ...action, round: 1 })).not.toBe(digestOf(action));
    expect(digestOf({ ...action, jobKey: 'c'.repeat(64) })).not.toBe(digestOf(action));
  });
});
```

**Manual denied-path script** — run each, screenshot or record, paste the outcome into `docs/world-debrief.md`:

| # | Path | How | Expected |
|---|---|---|---|
| D1 | Cancelled | start any World flow, tap **cancel/deny** in the World app | attempt `DENIED (access_denied)`; nothing changes |
| D2 | Expired | start a flow, do nothing for 20 min (or note the `expires_in`) | `EXPIRED`; nothing changes |
| D3 | Wrong human | revoke/over-cap started by owner A, approved by identity B | `DENIED (access_denied or wrong_human)`; agent stays ACTIVE / no payment |
| D4 | Replayed approval | approve an over-cap payment for job X, then call `POST /v1/pay` for job Y while that approval exists | the approval does not match Y's digest → a **new** approval is required; X's approval is never consumed by Y (P31) |
| D5 | Used approval | after an approval is `USED`, any further use | `409 APPROVAL_MISMATCH (already used)` |

**Exit checks**

- [ ] 2 approval tests pass
- [ ] D1–D5 observed and written down (they are the World "unsuccessful path" evidence)

**Commit:** `test(world): digest-bound approvals + documented denied/expired/cancelled/wrong-human/replay paths`

---

### Phase P28 — API: spending policy

**Goal:** per-human policy — **allowlist** (per merchant), **daily cap**, and **autonomous cap per payment**
above which a human must approve (Hedera extra point: "spending controls … human-in-the-loop approval above a
set amount"). **Time:** 35 min. **Depends:** P24.

**File: `services/api/src/policy.ts`** (replaces the P24 version)

```ts
import { ApiError } from '@forkos/shared';
import { sql } from './db';

export type PolicyDecision = { kind: 'ALLOW' } | { kind: 'NEEDS_APPROVAL'; reason: string };

export async function policyView(humanHash: string) {
  const [p] = await sql<{ cap_per_payment: string; daily_cap: string; allowlist: string[] }[]>`
    select cap_per_payment, daily_cap, allowlist from policies where human_hash = ${humanHash}`;
  return {
    capPerPayment: p?.cap_per_payment ?? '0',
    dailyCap: p?.daily_cap ?? '0',
    allowlist: p?.allowlist ?? [],
    spentToday: await spentToday(humanHash),
  };
}

async function spentToday(humanHash: string): Promise<string> {
  const [s] = await sql<{ spent: string }[]>`
    select coalesce(sum(amount), 0)::text as spent from intents
     where human_hash = ${humanHash} and created_at >= date_trunc('day', now())
       and status in ('CREATED','SENT','PAYMENT_UNKNOWN','PAID','DONE')`;
  return s?.spent ?? '0';
}

/** Throws POLICY_DENIED (hard limits) or returns ALLOW / NEEDS_APPROVAL (autonomous cap). */
export async function checkPolicy(humanHash: string, providerId: string, amount: bigint): Promise<PolicyDecision> {
  const p = await policyView(humanHash);
  if (!p.allowlist.includes(providerId)) throw new ApiError('POLICY_DENIED', `provider ${providerId} is not in your allowlist`);
  if (BigInt(p.spentToday) + amount > BigInt(p.dailyCap)) throw new ApiError('POLICY_DENIED', 'daily cap would be exceeded');
  if (amount > BigInt(p.capPerPayment)) return { kind: 'NEEDS_APPROVAL', reason: `amount ${amount} > autonomous cap ${p.capPerPayment}` };
  return { kind: 'ALLOW' };
}

export async function updatePolicy(humanHash: string, patch: { capPerPayment?: string; dailyCap?: string; allowlist?: string[] }) {
  await sql`
    update policies set
      cap_per_payment = coalesce(${patch.capPerPayment ?? null}::bigint, cap_per_payment),
      daily_cap       = coalesce(${patch.dailyCap ?? null}::bigint, daily_cap),
      allowlist       = coalesce(${patch.allowlist ?? null}::text[], allowlist),
      updated_at = now()
    where human_hash = ${humanHash}`;
  return policyView(humanHash);
}
```

**File: `services/api/src/routes/policy.ts`**

```ts
import { zIntString } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOwner } from '../auth';
import { PROVIDER_IDS } from '../config';
import { policyView, updatePolicy } from '../policy';

const Patch = z.object({
  capPerPayment: zIntString.optional(),
  dailyCap: zIntString.optional(),
  allowlist: z.array(z.enum(PROVIDER_IDS as [string, ...string[]])).optional(),
});

export function registerPolicyRoutes(app: FastifyInstance) {
  app.get('/v1/policy', async (req) => policyView((await requireOwner(req)).human_hash));
  app.put('/v1/policy', async (req) => updatePolicy((await requireOwner(req)).human_hash, Patch.parse(req.body)));
}
```

Register in **`services/api/src/index.ts`**: `registerPolicyRoutes(app);`

**Exit checks**

- [ ] `GET /v1/policy` → cap `1000000`, daily `5000000`, allowlist of the 3 providers, `spentToday: "0"`
- [ ] `PUT /v1/policy {"allowlist":["scribe-a"]}` → only `scribe-a` remains; `{"allowlist":["evil"]}` → `400`

**Commit:** `feat(api): spending policy — allowlist, daily cap, autonomous cap with approval above it`

---
### Phase P29 — API: job views (referee over HCS, Arkiv board, directory, timeline)

**Goal:** read endpoints used by agents and the dashboard. All answers come from **public data** (HCS via the
follower, Arkiv), not our database. **Time:** 35 min. **Depends:** P9, P10, P23.

Add `WINNER_HOLD_S = 600` to **`packages/shared/src/constants.ts`** (the winner extends its Arkiv claim by this
much right after winning, so approvals can take minutes without the claim expiring):

```ts
export const WINNER_HOLD_S = 600; // must be even
```

**File: `services/api/src/views.ts`**

```ts
import { listClaims, listServices, viewJob, type JobView } from '@forkos/shared';
import { REFEREE } from './config';
import { arkivPub, follower } from './clients';
import { sql, type IntentRow } from './db';

export async function jobView(jobKey: string): Promise<JobView> {
  await follower.sync();
  return viewJob(follower.messages, jobKey, REFEREE);
}

export function intentPublic(i: IntentRow) {
  return {
    intentId: i.id,
    jobKey: i.job_key,
    round: i.round,
    agentAddr: i.agent_addr,
    providerId: i.provider_id,
    payTo: i.pay_to,
    asset: i.asset,
    amount: i.amount,
    txId: i.tx_id,
    deadline: Number(i.deadline_s),
    status: i.status,
    attempts: i.attempts,
    consensusTimestamp: i.consensus_ts,
    lastError: i.last_error,
    result: i.result,
  };
}

export async function latestIntent(jobKey: string) {
  const [i] = await sql<IntentRow[]>`select * from intents where job_key = ${jobKey} order by round desc limit 1`;
  return i ?? null;
}

export async function directory() {
  const rows = await listServices(arkivPub);
  return rows.map((s) => ({ ...s, price: s.price.toString(), expiresAt: s.expiresAt.toString() }));
}

export async function board(jobKey: string) {
  const rows = await listClaims(arkivPub, jobKey);
  return rows.map((c) => ({ ...c, price: c.price.toString(), expiresAt: c.expiresAt.toString() }));
}

export async function timeline(jobKey: string) {
  await follower.sync();
  return follower.messages
    .filter((d) => d.msg && (('job' in d.msg && d.msg.job === jobKey) || d.msg.t === 'LINK' || d.msg.t === 'REVOKE'))
    .map((d) => ({ seq: d.seq, cts: d.cts, payer: d.payer, ...d.msg! }));
}
```

**File: `services/api/src/routes/jobs.ts`**

```ts
import { ApiError, CAPABILITY, NETWORK, HASHSCAN_BASE } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { requireOwnerOrAgent } from '../auth';
import { dep, env } from '../config';
import { sql, type IntentRow } from '../db';
import { board, directory, intentPublic, jobView, latestIntent, timeline } from '../views';

export function registerJobRoutes(app: FastifyInstance) {
  app.get('/v1/config', async () => ({
    network: NETWORK,
    capability: CAPABILITY,
    topicId: env.HCS_TOPIC_ID,
    operatorId: env.OPERATOR_ID,
    asset: env.PAY_ASSET,
    assetDecimals: env.PAY_ASSET_DECIMALS,
    mirrorUrl: env.MIRROR_URL,
    hashscan: HASHSCAN_BASE,
    providers: Object.entries(dep.providers).map(([id, p]) => ({ id, name: p.name, price: p.price, payTo: p.accountId })),
    baselineAgents: dep.baselineAgents,
    world: { issuer: env.WORLD_ISSUER, subStable: env.WORLD_SUB_STABLE },
  }));

  app.get<{ Params: { jobKey: string } }>('/v1/jobs/:jobKey', async (req) => {
    await requireOwnerOrAgent(req);
    const view = await jobView(req.params.jobKey);
    const intent = await latestIntent(req.params.jobKey);
    return { ...view, intent: intent ? intentPublic(intent) : null, onchainIntent: view.intent };
  });

  app.get<{ Params: { intentId: string } }>('/v1/intents/:intentId', async (req) => {
    await requireOwnerOrAgent(req);
    const [i] = await sql<IntentRow[]>`select * from intents where id = ${req.params.intentId}`;
    if (!i) throw new ApiError('NOT_FOUND', 'unknown intent');
    return intentPublic(i);
  });

  app.get('/v1/directory', async () => ({ services: await directory() }));
  app.get<{ Querystring: { jobKey: string } }>('/v1/board', async (req) => ({ claims: await board(req.query.jobKey) }));
  app.get<{ Querystring: { jobKey: string } }>('/v1/timeline', async (req) => ({ events: await timeline(req.query.jobKey) }));
}
```

Register in `index.ts`: `registerJobRoutes(app);`

**Exit checks**

- [ ] `/v1/config` lists 3 providers, `operatorId`, `topicId`
- [ ] `/v1/directory` returns the 3 Service entities **read from Arkiv**
- [ ] `/v1/jobs/<any 64-hex>` with an owner token → `{round:0, status:"OPEN", claims:[]}`

**Commit:** `feat(api): public job/directory/board/timeline views from HCS + Arkiv`

---

### Phase P30 — API: the payer (`POST /v1/pay`)

**Goal:** the heart of S3/S4. An agent that **won** a round asks the payer to pay. The payer re-checks
everything from public data, applies policy, builds the death-clocked intent **from the human's budget
account**, stores it **before sending** (unique per job+round), publishes `INTENT`, sends it through x402, and
records the outcome. **Time:** 90 min. **Depends:** P14, P15, P28, P29, P18.

Decision table inside `/v1/pay`:

| Situation | Response |
|---|---|
| `jobKey` ≠ `jobKeyOf(agent.human, inputHash)` | 400 (an agent can only buy for its own human) |
| job already PAID/DONE/REFUNDED | 200 with the existing intent + result (any agent of that human gets the answer — **this is the dedupe**) |
| `round` ≠ current round | 409 `ROUND_CLOSED` |
| caller is not the HCS winner | 409 `NOT_WINNER` |
| intent already exists for (job, round) | return its state (200 DONE / 202 PAYMENT_UNKNOWN / 202 PAYING) — never a second intent |
| over autonomous cap, no matching APPROVED approval | 202 `APPROVAL_REQUIRED` (P31) |
| otherwise | challenge → re-quote check → intent (persist) → `INTENT` on HCS → send → 200 / 202 |

**File: `services/api/src/payer.ts`**

```ts
import {
  ApiError,
  H_AGENT,
  H_CLAIM,
  H_JOB,
  H_ROUND,
  NETWORK,
  intentIdOf,
  jobKeyOf,
  listServices,
  memoOf,
  publishHcs,
} from '@forkos/shared';
import { buildIntentPayment, canResend, pickRequirement, type PaymentIntent } from '@forkos/x402-hedera';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { arkivPub, hedera } from './clients';
import { env } from './config';
import { decrypt } from './crypto';
import { sql, type AgentRow, type HumanRow, type IntentRow } from './db';
import { emit } from './events';
import { checkPolicy } from './policy';
import { intentPublic, jobView } from './views';
import { chaos } from './chaosState';

// Header codec only (no schemes needed for encoding / parsing).
const httpClient = new x402HTTPClient(new x402Client());

export type PayInput = { jobKey: string; round: number; audioUrl: string; inputHash: string; approvalId?: string };

export async function pay(agent: AgentRow, input: PayInput) {
  // 1. scope: only jobs of this agent's human
  if (jobKeyOf(agent.human_hash, input.inputHash) !== input.jobKey) {
    throw new ApiError('BAD_REQUEST', 'jobKey does not match your human and inputHash');
  }
  // 2. public truth
  const view = await jobView(input.jobKey);
  const existing = await sql<IntentRow[]>`select * from intents where job_key = ${input.jobKey} order by round desc limit 1`;
  if (view.status === 'PAID' || view.status === 'DONE' || view.status === 'REFUNDED') {
    return { http: 200, body: { status: view.status, intent: existing[0] ? intentPublic(existing[0]) : null, result: existing[0]?.result ?? null } };
  }
  if (input.round !== view.round) throw new ApiError('ROUND_CLOSED', `current round is ${view.round}`);
  if (!view.winner || view.winner.agent !== agent.agent_addr) throw new ApiError('NOT_WINNER', 'you are not the HCS winner of this round');
  if (view.winner.epoch !== agent.epoch) throw new ApiError('STALE_AUTHORITY', 'claim epoch is not your current epoch');

  // 3. one intent per (job, round)
  const [same] = await sql<IntentRow[]>`select * from intents where job_key = ${input.jobKey} and round = ${input.round}`;
  if (same) return describe(same);

  // 4. service from the Arkiv directory (the winner chose it in its claim)
  const service = (await listServices(arkivPub)).find((s) => s.providerId === view.winner!.svc);
  if (!service) throw new ApiError('UPSTREAM_FAILED', `service ${view.winner.svc} not in the Arkiv directory`);
  if (service.asset !== env.PAY_ASSET) throw new ApiError('POLICY_DENIED', 'service asks for an unsupported asset');

  // 5. policy
  const decision = await checkPolicy(agent.human_hash, service.providerId, service.price);
  const action = {
    kind: 'OVERCAP',
    human: agent.human_hash,
    jobKey: input.jobKey,
    round: input.round,
    providerId: service.providerId,
    payTo: service.payTo,
    amount: service.price.toString(),
    asset: service.asset,
  };
  if (decision.kind === 'NEEDS_APPROVAL') {
    const approved = await findUsableApproval(agent.human_hash, action);
    if (!approved) return requestOvercap(agent, action, decision.reason);
    input.approvalId = approved;
  }

  // 6. challenge from the provider (fenced there too)
  const headers = {
    'content-type': 'application/json',
    [H_JOB]: input.jobKey,
    [H_ROUND]: String(input.round),
    [H_AGENT]: agent.agent_addr,
    [H_CLAIM]: view.winner.arkivKey,
  };
  const body = JSON.stringify({ audioUrl: input.audioUrl, inputHash: input.inputHash });
  const challenge = await fetch(service.endpoint, { method: 'POST', headers, body });
  if (challenge.status === 409) {
    const err = (await challenge.json()) as { error: { code: string; message: string } };
    throw new ApiError(err.error.code as never, `provider fence: ${err.error.message}`);
  }
  if (challenge.status !== 402) throw new ApiError('UPSTREAM_FAILED', `expected 402 from provider, got ${challenge.status}`);
  const pr = httpClient.getPaymentRequiredResponse((n) => challenge.headers.get(n), await challenge.json());
  const req = pickRequirement(pr, NETWORK, env.PAY_ASSET);
  // re-quote check (the Tokyo lesson): what we are about to sign must match the directory + policy decision
  if (req.payTo !== service.payTo || BigInt(req.amount) !== service.price) {
    throw new ApiError('POLICY_DENIED', 'provider quote differs from the Arkiv directory (payTo or price changed)');
  }

  // 7. build the intent from the human's budget account; persist BEFORE anything is sent
  const [human] = await sql<HumanRow[]>`select * from humans where human_hash = ${agent.human_hash}`;
  const id = intentIdOf(input.jobKey, input.round);
  let built: { payload: PaymentPayload; intent: PaymentIntent };
  try {
    built = await buildIntentPayment(pr, req, {
      accountId: human!.budget_account_id,
      privateKey: decrypt(human!.budget_key_enc),
      memo: memoOf(input.jobKey, input.round),
      persist: (intent) => persistIntent(id, agent, input, service.providerId, service.endpoint, intent, action),
    });
  } catch (err) {
    // unique (job_key, round) violation = a concurrent request created it first → report that one
    const [raced] = await sql<IntentRow[]>`select * from intents where job_key = ${input.jobKey} and round = ${input.round}`;
    if (raced) return describe(raced);
    throw err;
  }
  // persistIntent has stored the payload-less row; store the exact payload now (same bytes on every resend)
  await sql`update intents set payment_payload = ${sql.json(built.payload as never)} where id = ${id}`;

  // 8. public INTENT before sending
  await publishHcs(hedera, env.HCS_TOPIC_ID, {
    v: 1,
    t: 'INTENT',
    job: input.jobKey,
    round: input.round,
    agent: agent.agent_addr,
    tx: built.intent.txId,
    dl: built.intent.deadlineS,
    amt: req.amount,
    asset: req.asset,
    payTo: req.payTo,
  });
  await emit('intent.created', {
    intentId: id,
    jobKey: input.jobKey,
    round: input.round,
    txId: built.intent.txId,
    deadline: built.intent.deadlineS,
    amount: req.amount,
    payTo: req.payTo,
  });

  // 9. send
  const [row] = await sql<IntentRow[]>`select * from intents where id = ${id}`;
  return describe(await sendIntent(row!));
}

async function persistIntent(
  id: string,
  agent: AgentRow,
  input: PayInput,
  providerId: string,
  endpoint: string,
  intent: PaymentIntent,
  action: Record<string, unknown>,
) {
  await sql.begin(async (tx) => {
    if (input.approvalId) {
      const { consumeApproval } = await import('./approvals');
      await consumeApproval(tx as unknown as typeof sql, input.approvalId, action);
    }
    await tx`
      insert into intents (id, job_key, round, human_hash, agent_addr, provider_id, endpoint, pay_to, asset, amount, tx_id,
                           valid_start_ms, deadline_s, memo, payment_payload, requirements, request_body, status, approval_id)
      values (${id}, ${input.jobKey}, ${input.round}, ${agent.human_hash}, ${agent.agent_addr}, ${providerId}, ${endpoint},
              ${intent.requirements.payTo}, ${intent.requirements.asset}, ${intent.requirements.amount}, ${intent.txId},
              ${intent.validStartMs}, ${intent.deadlineS}, ${intent.memo}, ${tx.json({ pending: true } as never)},
              ${tx.json(intent.requirements as never)},
              ${tx.json({ audioUrl: input.audioUrl, inputHash: input.inputHash } as never)}, 'CREATED', ${input.approvalId ?? null})`;
  });
}

/** Sends (or resends) the stored payload — never re-signs. Returns the updated row. */
export async function sendIntent(row: IntentRow): Promise<IntentRow> {
  if (!canResend(Number(row.deadline_s))) {
    const [r] = await sql<IntentRow[]>`update intents set status = 'PAYMENT_UNKNOWN', updated_at = now() where id = ${row.id} returning *`;
    return r!;
  }
  const view = await jobView(row.job_key);
  const headers = {
    'content-type': 'application/json',
    [H_JOB]: row.job_key,
    [H_ROUND]: String(row.round),
    [H_AGENT]: row.agent_addr,
    [H_CLAIM]: view.winner?.arkivKey ?? '',
    ...httpClient.encodePaymentSignatureHeader(row.payment_payload as unknown as PaymentPayload),
  };
  await sql`update intents set status = 'SENT', attempts = attempts + 1, updated_at = now() where id = ${row.id}`;

  const ctrl = new AbortController();
  const killMs = chaos.takeKill(); // P39: "kill the payer mid-flight"
  const timer = setTimeout(() => ctrl.abort(), killMs ?? 90_000);
  try {
    const res = await fetch(row.endpoint, { method: 'POST', headers, body: JSON.stringify(row.request_body), signal: ctrl.signal });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (res.status === 200) {
      const settle = safeSettle(res);
      const status = json.status === 'REFUNDED' ? 'REFUNDED' : json.status === 'DONE' ? 'DONE' : 'PAID';
      const [r] = await sql<IntentRow[]>`
        update intents set status = ${status}, settle_response = ${sql.json((settle ?? {}) as never)},
               result = ${sql.json(json as never)}, last_error = null, updated_at = now()
         where id = ${row.id} returning *`;
      await afterPaid(r!);
      return r!;
    }
    if (res.status === 202) {
      const [r] = await sql<IntentRow[]>`update intents set status = 'PAYMENT_UNKNOWN', last_error = 'provider still running', updated_at = now() where id = ${row.id} returning *`;
      await emit('payment.unknown', { intentId: row.id, txId: row.tx_id, deadline: Number(row.deadline_s) });
      return r!;
    }
    // 402 / 409 / 4xx: the provider refused → money should not have moved; the resolver proves it (VOID) or finds PAID.
    const reason = json?.error?.code ?? json?.error ?? `http_${res.status}`;
    const [r] = await sql<IntentRow[]>`update intents set status = 'REJECTED', last_error = ${String(reason)}, updated_at = now() where id = ${row.id} returning *`;
    return r!;
  } catch (err) {
    // timeout, abort, connection reset: we do NOT know → resolver
    const [r] = await sql<IntentRow[]>`update intents set status = 'PAYMENT_UNKNOWN', last_error = ${(err as Error).message}, updated_at = now() where id = ${row.id} returning *`;
    await emit('payment.unknown', { intentId: row.id, txId: row.tx_id, deadline: Number(row.deadline_s) });
    return r!;
  } finally {
    clearTimeout(timer);
  }
}

function safeSettle(res: Response) {
  try {
    return httpClient.getPaymentSettleResponse((n) => res.headers.get(n));
  } catch {
    return null;
  }
}

/** PAID/DONE/REFUNDED from a live response: emit now; SETTLED/DONE on HCS are published by the resolver once Mirror confirms. */
async function afterPaid(r: IntentRow) {
  await emit('payment.paid', { intentId: r.id, txId: r.tx_id, consensusTimestamp: null, hashscan: null });
  const result = r.result as { outputHash?: string; summary?: string; refundTxId?: string } | null;
  if (r.status === 'DONE') await emit('job.done', { intentId: r.id, jobKey: r.job_key, outputHash: result?.outputHash, summary: result?.summary });
  if (r.status === 'REFUNDED') await emit('refund.sent', { jobKey: r.job_key, round: r.round, txId: r.tx_id, refundTxId: result?.refundTxId });
}

export function describe(r: IntentRow) {
  const pub = intentPublic(r);
  if (r.status === 'DONE' || r.status === 'PAID' || r.status === 'REFUNDED') return { http: 200, body: { status: r.status, intent: pub, result: r.result } };
  if (r.status === 'VOID' || r.status === 'FAILED') return { http: 409, body: { error: { code: 'ROUND_CLOSED', message: `intent ${r.status}; claim the next round` }, intent: pub } };
  return { http: 202, body: { status: r.status === 'REJECTED' ? 'PAYMENT_UNKNOWN' : r.status, intent: pub } };
}

// P31 replaces these two with the real World flow.
async function findUsableApproval(_human: string, _action: Record<string, unknown>): Promise<string | null> {
  return null;
}
async function requestOvercap(_agent: AgentRow, _action: Record<string, unknown>, reason: string) {
  throw new ApiError('POLICY_DENIED', `${reason} (approvals arrive in P31)`);
}
```

> Why `persistIntent` stores `{pending:true}` then the payload: `buildIntentPayment` persists from inside the
> signer (before the x402 client finishes building the payload object). The **transaction bytes** — the only
> thing that matters for exactly-once — are already in the row (`tx_id` + deadline), and the full payload is
> written immediately after, still before anything is sent.

**File: `services/api/src/chaosState.ts`**

```ts
let killNext = false;
export const chaos = {
  armKill() {
    killNext = true;
  },
  /** Returns 400 (ms) once after arming, else null. */
  takeKill(): number | null {
    if (!killNext) return null;
    killNext = false;
    return 400;
  },
};
```

**File: `services/api/src/routes/pay.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAgent } from '../auth';
import { pay } from '../payer';

const Body = z.object({
  jobKey: z.string().regex(/^[0-9a-f]{64}$/),
  round: z.number().int().nonnegative(),
  audioUrl: z.string().url(),
  inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export function registerPayRoutes(app: FastifyInstance) {
  app.post('/v1/pay', async (req, reply) => {
    const agent = await requireAgent(req);
    const out = await pay(agent, Body.parse(req.body));
    return reply.code(out.http).send(out.body);
  });
}
```

Register in `index.ts`: `registerPayRoutes(app);`

**Exit checks** (full live run comes with P35's agent kit; minimal checks now)

- [ ] `POST /v1/pay` with an agent token and a wrong `jobKey` → `400`
- [ ] With a valid job but no claims → `409 NOT_WINNER`
- [ ] `pnpm typecheck` passes

**Commit:** `feat(api): payer — winner-only, one intent per round, persisted before send, resend same bytes`

---

### Phase P31 — API: over-cap approval (World-protected action #3)

**Goal:** a payment above the autonomous cap pauses until the human approves **that exact payment** (digest of
job, round, provider, payTo, amount, asset) with a fresh World authentication. The approval is consumed in the
**same database transaction** that stores the intent. **Time:** 45 min. **Depends:** P30, P26.

Replace the two P30 placeholders at the bottom of **`services/api/src/payer.ts`** with:

```ts
async function findUsableApproval(human: string, action: Record<string, unknown>): Promise<string | null> {
  const { digestOf } = await import('@forkos/shared');
  const [a] = await sql<{ id: string }[]>`
    select id from approvals
     where human_hash = ${human} and kind = 'OVERCAP' and status = 'APPROVED'
       and digest = ${digestOf(action)} and expires_at > now()
     order by created_at desc limit 1`;
  return a?.id ?? null;
}

async function requestOvercap(agent: AgentRow, action: Record<string, unknown>, reason: string) {
  const { digestOf } = await import('@forkos/shared');
  const { createApproval } = await import('./approvals');
  // reuse a still-pending approval for the same action instead of spamming the phone
  const [pending] = await sql<{ id: string; world_attempt_id: string }[]>`
    select id, world_attempt_id from approvals
     where human_hash = ${agent.human_hash} and kind = 'OVERCAP' and status = 'PENDING'
       and digest = ${digestOf(action)} and expires_at > now() limit 1`;
  if (pending) {
    const [w] = await sql<{ user_code: string; verification_uri_complete: string | null }[]>`
      select user_code, verification_uri_complete from world_attempts where id = ${pending.world_attempt_id}`;
    return { http: 202, body: { status: 'APPROVAL_REQUIRED', approvalId: pending.id, userCode: w?.user_code, verificationUriComplete: w?.verification_uri_complete, reason } };
  }
  const [human] = await sql<HumanRow[]>`select * from humans where human_hash = ${agent.human_hash}`;
  const created = await createApproval(agent.human_hash, human!.sub, 'OVERCAP', action);
  return {
    http: 202,
    body: { status: 'APPROVAL_REQUIRED', approvalId: created.approvalId, userCode: created.userCode, verificationUriComplete: created.verificationUriComplete, reason },
  };
}
```

Register the World handlers once (in **`services/api/src/routes/pay.ts`**, inside `registerPayRoutes`):

```ts
import { setApprovalStatus } from '../approvals';
import { onWorldApproved, onWorldNotApproved } from '../world';
import type { AttemptRow } from '../db';
// inside registerPayRoutes(app):
onWorldApproved('OVERCAP', async (row: AttemptRow) => {
  await setApprovalStatus((row.context as { approvalId: string }).approvalId, 'APPROVED');
});
onWorldNotApproved('OVERCAP', async (row: AttemptRow) => {
  await setApprovalStatus((row.context as { approvalId: string }).approvalId, row.status === 'EXPIRED' ? 'EXPIRED' : 'DENIED');
});
```

Flow for the agent: `POST /v1/pay` → `202 APPROVAL_REQUIRED` → poll `GET /v1/jobs/:jobKey` (or wait for SSE
`approval.resolved`) → call `POST /v1/pay` again with the same body → the payer finds the `APPROVED` approval
for the identical digest and consumes it while inserting the intent. A different job/amount/payee has a
different digest, so an approval can never be replayed for another payment (D4/D5 in P27).

**Exit checks**

- [ ] Agent buys from `scribe-premium` (2 FUSD > 1 FUSD cap) → `202 APPROVAL_REQUIRED` + SSE `approval.pending`
- [ ] Approve on the phone → second `/v1/pay` → `200 DONE`; approval `USED`; `intents.approval_id` set
- [ ] Deny → approval `DENIED`; `/v1/pay` again → a **new** approval is requested; no intent row exists

**Commit:** `feat(api): over-cap payments require a World approval bound to the exact payment digest`

---

### Phase P32 — API: the resolver worker

**Goal:** turns every unknown outcome into PAID / VOID with proof, publishes `SETTLED`, `DONE`, `VOID` to HCS,
fetches results after lost responses, resends the **same bytes** once while safe, and closes abandoned rounds.
**Time:** 60 min. **Depends:** P15, P30.

**File: `services/api/src/resolver.ts`**

```ts
import { WINNER_GRACE_S, hashscan, jobKeysIn, publishHcs } from '@forkos/shared';
import { canResend, resolveIntent } from '@forkos/x402-hedera';
import { follower, hedera, mirror } from './clients';
import { env } from './config';
import { sql, type IntentRow } from './db';
import { emit } from './events';
import { sendIntent } from './payer';
import { jobView } from './views';

async function publishSettled(r: IntentRow, cts: string) {
  await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'SETTLED', job: r.job_key, round: r.round, tx: r.tx_id, cts });
  await sql`update intents set consensus_ts = ${cts}, updated_at = now() where id = ${r.id}`;
  await emit('payment.paid', { intentId: r.id, txId: r.tx_id, consensusTimestamp: cts, hashscan: hashscan.tx(cts) });
}

async function publishDone(r: IntentRow) {
  const out = (r.result as { outputHash?: string } | null)?.outputHash;
  if (!out) return;
  await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'DONE', job: r.job_key, round: r.round, svc: r.provider_id, out });
}

/** Ask the provider for the result of a payment we know settled. */
async function fetchResult(r: IntentRow) {
  const base = r.endpoint.replace(/\/v1\/jobs$/, '');
  const res = await fetch(`${base}/v1/jobs/by-payment/${encodeURIComponent(r.tx_id)}`);
  if (!res.ok) return null;
  return (await res.json()) as { status: string; outputHash?: string; summary?: string; refundTxId?: string };
}

async function tickIntents() {
  // stale SENT (process died mid-request) → unknown
  await sql`update intents set status = 'PAYMENT_UNKNOWN', updated_at = now() where status = 'SENT' and updated_at < now() - interval '100 seconds'`;

  const open = await sql<IntentRow[]>`select * from intents where status in ('PAYMENT_UNKNOWN','REJECTED') order by created_at limit 20`;
  for (const r of open) {
    const st = await resolveIntent(mirror, r.tx_id, Number(r.deadline_s));
    if (st.state === 'PAID') {
      await sql`update intents set status = 'PAID', updated_at = now() where id = ${r.id}`;
      await publishSettled(r, st.consensusTimestamp);
      continue; // result fetched below in the PAID pass
    }
    if (st.state === 'FAILED' || st.state === 'VOID') {
      await sql`update intents set status = 'VOID', last_error = ${st.state === 'FAILED' ? st.result : 'proven void'}, updated_at = now() where id = ${r.id}`;
      await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'VOID', job: r.job_key, round: r.round, tx: r.tx_id });
      await emit('payment.void', { intentId: r.id, txId: r.tx_id, provedAt: new Date().toISOString() });
      continue;
    }
    // UNKNOWN: resend the SAME bytes once while it is still safe (never re-sign)
    if (r.status === 'PAYMENT_UNKNOWN' && r.attempts < 2 && canResend(Number(r.deadline_s))) await sendIntent(r);
  }

  // PAID / DONE / REFUNDED that still need SETTLED or DONE on HCS, or a result
  const paid = await sql<IntentRow[]>`select * from intents where status in ('PAID','DONE','REFUNDED') and (consensus_ts is null or (status = 'PAID')) limit 20`;
  for (const r of paid) {
    if (!r.consensus_ts) {
      const found = await mirror.getTransaction(r.tx_id);
      if (found.found && found.success) await publishSettled(r, found.consensusTimestamp);
      else continue;
    }
    if (r.status === 'PAID') {
      const result = await fetchResult(r);
      if (result?.status === 'DONE') {
        const [u] = await sql<IntentRow[]>`update intents set status = 'DONE', result = ${sql.json(result as never)}, updated_at = now() where id = ${r.id} returning *`;
        await publishDone(u!);
        await emit('job.done', { intentId: r.id, jobKey: r.job_key, outputHash: result.outputHash, summary: result.summary });
      } else if (result?.status === 'REFUNDED') {
        await sql`update intents set status = 'REFUNDED', result = ${sql.json(result as never)}, updated_at = now() where id = ${r.id}`;
        await emit('refund.sent', { jobKey: r.job_key, round: r.round, txId: r.tx_id, refundTxId: result.refundTxId });
      }
    } else if (r.status === 'DONE') {
      const view = await jobView(r.job_key);
      if (!view.done) await publishDone(r);
    }
  }
}

/** A winner that never produced an INTENT within WINNER_GRACE_S (and has no pending approval) → VOID none. */
async function tickAbandoned() {
  await follower.sync();
  const nowS = Date.now() / 1000;
  for (const jobKey of jobKeysIn(follower.messages)) {
    const view = await jobView(jobKey);
    if (view.status !== 'CLAIMED' || !view.winner) continue;
    const age = nowS - Number(view.winner.cts.split('.')[0]);
    if (age < WINNER_GRACE_S) continue;
    const [intent] = await sql`select 1 from intents where job_key = ${jobKey} and round = ${view.round}`;
    if (intent) continue;
    const [pending] = await sql`select 1 from approvals where status in ('PENDING','APPROVED') and action->>'jobKey' = ${jobKey}
                                  and (action->>'round')::int = ${view.round} and expires_at > now()`;
    if (pending) continue;
    await publishHcs(hedera, env.HCS_TOPIC_ID, { v: 1, t: 'VOID', job: jobKey, round: view.round, tx: 'none' });
    await emit('payment.void', { intentId: null, txId: 'none', provedAt: new Date().toISOString(), jobKey, round: view.round });
  }
}

export function startResolver(log: { error: (o: object, m: string) => void }) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tickIntents();
      await tickAbandoned();
    } catch (err) {
      log.error({ err }, 'resolver tick failed');
    } finally {
      busy = false;
    }
  }, 3000);
}
```

Register in `index.ts`: `import { startResolver } from './resolver';` … `startResolver(app.log);`

> The resolver is the **only** writer of `SETTLED`, `DONE` and `VOID`, and it writes `SETTLED` only after Mirror
> Node shows `SUCCESS`. So every HCS claim of payment is backed by ledger evidence the audit CLI re-checks.

**Exit checks** (live in P39; logic proven by P15 smoke + resolver tests)

- [ ] `pnpm typecheck` passes; API logs no `resolver tick failed` while idle

**Commit:** `feat(api): resolver — mirror-backed SETTLED/VOID, same-bytes resend, result fetch, abandoned rounds`

---

### Phase P33 — API: Mirror-Node payment counter

**Goal:** the number on the big screen — payments per job **counted from Mirror Node**, not our DB. ForkOS
lane: transfers from the human's budget account whose memo is `forkos:<jobShort>:r*`. Baseline lane: FUSD
transfers from the baseline accounts to any provider since `since`. **Time:** 30 min. **Depends:** P29.

**File: `services/api/src/routes/counter.ts`**

```ts
import { ApiError, jobShort, parseMemo, type MirrorTransaction } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mirror } from '../clients';
import { dep, env, PROVIDER_ACCOUNTS } from '../config';
import { sql } from '../db';

function paidToProvider(t: MirrorTransaction, from: string): { to: string; amount: string } | null {
  if (t.result !== 'SUCCESS') return null;
  const legs = (t.token_transfers ?? []).filter((x) => x.token_id === env.PAY_ASSET);
  const out = legs.find((x) => x.account === from && x.amount < 0);
  const inn = legs.find((x) => PROVIDER_ACCOUNTS.includes(x.account) && x.amount > 0);
  return out && inn ? { to: inn.account, amount: String(inn.amount) } : null;
}

export function registerCounterRoutes(app: FastifyInstance) {
  app.get('/v1/counter', async (req) => {
    const q = z.object({ jobKey: z.string().regex(/^[0-9a-f]{64}$/), since: z.coerce.number().optional() }).parse(req.query);
    const [owner] = await sql<{ budget_account_id: string }[]>`
      select h.budget_account_id from intents i join humans h on h.human_hash = i.human_hash where i.job_key = ${q.jobKey} limit 1`;

    const forkosTxs: { txId: string; cts: string; to: string; amount: string }[] = [];
    if (owner) {
      for (const t of await mirror.accountTransfers(owner.budget_account_id, 100)) {
        const memo = t.memo_base64 ? Buffer.from(t.memo_base64, 'base64').toString('utf8') : '';
        const m = parseMemo(memo);
        const leg = paidToProvider(t, owner.budget_account_id);
        if (m && m.jobShort === jobShort(q.jobKey) && leg) forkosTxs.push({ txId: t.transaction_id, cts: t.consensus_timestamp, ...leg });
      }
    }

    const sinceS = q.since ?? 0;
    const baselineTxs: typeof forkosTxs = [];
    for (const acct of dep.baselineAgents) {
      for (const t of await mirror.accountTransfers(acct, 50)) {
        if (Number(t.consensus_timestamp.split('.')[0]) < sinceS) continue;
        const leg = paidToProvider(t, acct);
        if (leg) baselineTxs.push({ txId: t.transaction_id, cts: t.consensus_timestamp, ...leg });
      }
    }
    if (!owner && !q.since) throw new ApiError('NOT_FOUND', 'no ForkOS intent for this job yet; pass ?since= for the baseline lane');
    return {
      jobKey: q.jobKey,
      source: 'mirror',
      forkos: { payments: forkosTxs.length, txs: forkosTxs },
      baseline: { payments: baselineTxs.length, txs: baselineTxs },
    };
  });
}
```

Register in `index.ts`: `registerCounterRoutes(app);` — and make the 404 a soft response for the dashboard by
always passing `since` (the dashboard records it when it starts a race).

**Exit checks**

- [ ] After the P15 smoke payment: `/v1/counter?jobKey=<any>&since=<smoke time - 60>` shows `baseline.payments: 1` (the smoke paid from baseline account 1)

**Commit:** `feat(api): payment counter computed from Mirror Node (forkos memo lane + baseline lane)`

---

### Phase P34 — API: SSE feed from HCS + demo routes (**H1 handoff**)

**Goal:** turn new HCS messages into dashboard events (`claim.posted/won/lost`, `counter.update`), add the demo
helper route, and hand the API to the frontend. **Time:** 35 min. **Depends:** P29–P33.

**File: `services/api/src/feed.ts`**

```ts
import { type Decoded, viewJob } from '@forkos/shared';
import { REFEREE } from './config';
import { follower } from './clients';
import { emit } from './events';

/** Called by the topic follower with new messages. */
export async function onNewMessages(fresh: Decoded[]) {
  for (const d of fresh) {
    const m = d.msg;
    if (!m || m.t !== 'CLAIM') continue;
    await emit('claim.posted', { jobKey: m.job, round: m.round, agentAddr: m.agent, svc: m.svc, price: m.price, seq: d.seq, arkivKey: m.ak });
    const view = viewJob(follower.messages, m.job, REFEREE);
    const me = view.claims.find((c) => c.seq === d.seq);
    if (me && view.winner && view.winner.seq === d.seq) {
      await emit('claim.won', { jobKey: m.job, round: m.round, agentAddr: m.agent, seq: d.seq });
    } else if (me) {
      await emit('claim.lost', { jobKey: m.job, round: m.round, agentAddr: m.agent, seq: d.seq, winnerSeq: view.winner?.seq ?? null, reason: me.reason });
    }
  }
}
```

**File: `services/api/src/routes/demo.ts`**

```ts
import { inputHashOf } from '@forkos/shared';
import type { FastifyInstance } from 'fastify';
import { requireDemo } from '../auth';
import { env } from '../config';

let cached: { audioUrl: string; inputHash: string } | null = null;

export function registerDemoRoutes(app: FastifyInstance) {
  app.post('/v1/demo/job', async (req) => {
    requireDemo(req);
    if (!cached) {
      const bytes = new Uint8Array(await (await fetch(env.SAMPLE_AUDIO_URL)).arrayBuffer());
      cached = { audioUrl: env.SAMPLE_AUDIO_URL, inputHash: inputHashOf(bytes) };
    }
    return cached;
  });
}
```

Change the follower start line in **`services/api/src/index.ts`** to:

```ts
import { onNewMessages } from './feed';
follower.start(2000, onNewMessages);
```

and register `registerDemoRoutes(app);`.

**Final `services/api/src/index.ts`** (for reference — this is the complete file after P34):

**File: `services/api/src/index.ts`**

```ts
import cors from '@fastify/cors';
import { ApiError, NETWORK, portFrom } from '@forkos/shared';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { follower } from './clients';
import { env, WEB_ORIGINS } from './config';
import { registerSse } from './events';
import { onNewMessages } from './feed';
import { startResolver } from './resolver';
import { registerAgentRoutes } from './routes/agents';
import { registerChaosRoutes } from './routes/chaos';
import { registerCounterRoutes } from './routes/counter';
import { registerDemoRoutes } from './routes/demo';
import { registerJobRoutes } from './routes/jobs';
import { registerOwnerRoutes } from './routes/owner';
import { registerPayRoutes } from './routes/pay';
import { registerPolicyRoutes } from './routes/policy';
import { startWorldWorker } from './world';

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 1_000_000 });

await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || WEB_ORIGINS.includes('*') || WEB_ORIGINS.includes(origin)),
  allowedHeaders: ['content-type', 'authorization', 'x-demo-key', 'last-event-id'],
  methods: ['GET', 'POST', 'PUT'],
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ApiError) return reply.code(err.status).send(err.toJSON());
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
  }
  req.log.error({ err }, 'unhandled');
  return reply.code(500).send({ error: { code: 'UPSTREAM_FAILED', message: (err as Error).message } });
});

app.get('/v1/health', async () => ({ ok: true, network: NETWORK, topicId: env.HCS_TOPIC_ID, asset: env.PAY_ASSET, hcsSeq: follower.latestSeq, version: '0.1.0' }));

registerSse(app);
registerOwnerRoutes(app);
registerAgentRoutes(app);
registerPolicyRoutes(app);
registerJobRoutes(app);
registerPayRoutes(app);
registerCounterRoutes(app);
registerDemoRoutes(app);
registerChaosRoutes(app); // P39 — create routes/chaos.ts as `export function registerChaosRoutes(_app: unknown) {}` until then

follower.start(2000, onNewMessages);
startWorldWorker(app.log);
startResolver(app.log);

const port = portFrom('API_PORT', 4000);
await app.listen({ host: '0.0.0.0', port });
```

**H1 handoff to Frontend** — post in team chat:

```text
H1 ready: API at http://<your-lan-ip>:4000  (WEB_ORIGIN includes the frontend dev URL)
Contract: ICD-7 (endpoints), ICD-8 (SSE), ICD-11 (states).
Owner login: POST /v1/owner/login/start → poll GET /v1/owner/login/:id → token.
Demo key for /v1/demo/* and /v1/chaos/*: sent privately.
```

**Exit checks**

- [ ] Frontend dev can `curl` `/v1/config` and open `/v1/events` from their machine
- [ ] Posting a CLAIM (P35) produces `claim.posted` + `claim.won`/`claim.lost` on SSE

**Commit:** `feat(api): SSE feed from HCS claims + demo job route (H1 handoff)`

---
### Phase P35 — `@forkos/agent-kit`: the agent side

**Goal:** everything an agent does, in one class: identity (one secp256k1 key = Hedera account key + Arkiv
wallet), discover services on Arkiv, compute the job key, **post its claim to Arkiv and HCS with its own
key**, read the referee, extend/patch its claim, call `/v1/pay`, wait through approvals and unknowns, and get
the result even when another agent won. **Time:** 75 min. **Depends:** P8–P10, P30.

**File: `packages/agent-kit/src/identity.ts`**

```ts
import { PrivateKey } from '@hiero-ledger/sdk';
import { privateKeyToAccount } from 'viem/accounts';

/** One secp256k1 key → EVM address (Arkiv wallet) + Hedera ECDSA key (agent's Hedera account). */
export function agentIdentity(key: `0x${string}`) {
  const evm = privateKeyToAccount(key);
  const hederaKey = PrivateKey.fromStringECDSA(key.slice(2));
  return { key, address: evm.address.toLowerCase(), publicKeyHex: hederaKey.publicKey.toStringRaw(), hederaKey };
}
```

**File: `packages/agent-kit/src/api.ts`**

```ts
export type ApiResult<T = any> = { http: number; body: T };

export class ForkosApi {
  constructor(
    readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private async call<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<ApiResult<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { http: res.status, body: text ? JSON.parse(text) : {} };
  }

  private async ok<T = any>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
    const r = await this.call<T>(method, path, body, extra);
    if (r.http >= 400) throw new Error(`${method} ${path} → ${r.http} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  config() {
    return this.ok('GET', '/v1/config');
  }
  me() {
    return this.ok<{ agentAddr: string; humanHash: string; accountId: string; epoch: number; status: string; label: string }>('GET', '/v1/me/agent');
  }
  job(jobKey: string) {
    return this.ok('GET', `/v1/jobs/${jobKey}`);
  }
  directory() {
    return this.ok<{ services: { providerId: string; name: string; price: string; endpoint: string; payTo: string; asset: string }[] }>('GET', '/v1/directory');
  }
  pay(body: { jobKey: string; round: number; audioUrl: string; inputHash: string }) {
    return this.call('POST', '/v1/pay', body);
  }
  demoJob(demoKey: string) {
    return this.ok<{ audioUrl: string; inputHash: string }>('POST', '/v1/demo/job', {}, { 'x-demo-key': demoKey });
  }
  counter(jobKey: string, since: number) {
    return this.ok('GET', `/v1/counter?jobKey=${jobKey}&since=${since}`);
  }

  linkStart(body: { agentAddr: string; publicKeyHex: string; label: string; pairingCode?: string }) {
    return this.ok<{ linkId: string; userCode: string; verificationUri: string; verificationUriComplete: string | null }>(
      'POST',
      '/v1/agents/link/start',
      body,
    );
  }
  async linkWait(linkId: string): Promise<{ agentToken: string; agent: { agentAddr: string; accountId: string; epoch: number; humanHash: string } }> {
    for (;;) {
      const r = await this.ok<any>('GET', `/v1/agents/link/${linkId}`);
      if (r.status === 'LINKED') return r;
      if (['DENIED', 'EXPIRED', 'FAILED'].includes(r.status)) throw new Error(`link ${r.status}: ${r.reason ?? ''}`);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}
```

**File: `packages/agent-kit/src/agent.ts`**

```ts
import {
  CLAIM_WINDOW_S,
  ClaimSchema,
  ExpirationTime,
  Mirror,
  TopicFollower,
  WINNER_HOLD_S,
  arkivPublic,
  arkivWallet,
  clientFor,
  inputHashOf,
  jobKeyOf,
  listServices,
  publishHcs,
  u64,
  viewJob,
  type JobView,
  type ServiceRow,
} from '@forkos/shared';
import { ForkosApi } from './api';
import { agentIdentity } from './identity';

export type AgentOptions = {
  key: `0x${string}`;
  token: string;
  apiUrl: string;
  arkivAccessKey: string;
  mirrorUrl?: string;
  log?: (msg: string, extra?: unknown) => void;
  onApproval?: (info: { approvalId: string; userCode?: string; verificationUriComplete?: string }) => void;
};

export type BuyOutcome =
  | { kind: 'PAID_BY_ME'; jobKey: string; round: number; result: unknown; intent: unknown }
  | { kind: 'PAID_BY_OTHER'; jobKey: string; round: number; result: unknown; winner: string }
  | { kind: 'FAILED'; jobKey: string; reason: string };

export class ForkosAgent {
  readonly id;
  readonly api: ForkosApi;
  private cfg: any;
  private me!: Awaited<ReturnType<ForkosApi['me']>>;
  private follower!: TopicFollower;
  private hedera!: ReturnType<typeof clientFor>;
  private pub;
  private wallet;
  private log: NonNullable<AgentOptions['log']>;

  constructor(private readonly opts: AgentOptions) {
    this.id = agentIdentity(opts.key);
    this.api = new ForkosApi(opts.apiUrl, opts.token);
    this.pub = arkivPublic(opts.arkivAccessKey);
    this.wallet = arkivWallet(opts.arkivAccessKey, opts.key);
    this.log = opts.log ?? ((m, e) => console.log(`[${this.id.address.slice(0, 8)}] ${m}`, e ?? ''));
  }

  async init() {
    this.cfg = await this.api.config();
    this.me = await this.api.me();
    this.hedera = clientFor(this.me.accountId, this.id.hederaKey);
    this.follower = new TopicFollower(new Mirror(this.opts.mirrorUrl ?? this.cfg.mirrorUrl), this.cfg.topicId);
    return this;
  }

  private referee() {
    return { operatorId: this.cfg.operatorId as string, providerAccounts: (this.cfg.providers as { payTo: string }[]).map((p) => p.payTo) };
  }

  async view(jobKey: string): Promise<JobView> {
    await this.follower.sync();
    return viewJob(this.follower.messages, jobKey, this.referee());
  }

  async discover(): Promise<ServiceRow[]> {
    return listServices(this.pub);
  }

  async jobFor(audioUrl: string) {
    const bytes = new Uint8Array(await (await fetch(audioUrl)).arrayBuffer());
    const inputHash = inputHashOf(bytes);
    return { audioUrl, inputHash, jobKey: jobKeyOf(this.me.humanHash, inputHash) };
  }

  /** Posts a claim (Arkiv, owned by me) + CLAIM (HCS, paid by my account) and reads the referee. */
  async claim(jobKey: string, svc: ServiceRow) {
    const before = await this.view(jobKey);
    const round = before.round;
    const entity = await this.wallet.createEntity(
      ClaimSchema,
      {
        job: jobKey,
        round: u64(round),
        human: this.me.humanHash,
        agent: this.id.address,
        status: 'OPEN',
        epoch: u64(this.me.epoch),
        svc: svc.providerId,
        price: u64(svc.price),
        seq: u64(0),
        tx: '-',
      },
      { expiration: ExpirationTime.fromSeconds(CLAIM_WINDOW_S) },
    );
    const { seq } = await publishHcs(this.hedera, this.cfg.topicId, {
      v: 1,
      t: 'CLAIM',
      job: jobKey,
      round,
      human: this.me.humanHash,
      agent: this.id.address,
      epoch: this.me.epoch,
      svc: svc.providerId,
      price: svc.price.toString(),
      ak: entity.entityKey.toLowerCase(),
    });
    this.log(`claimed round ${round} via ${svc.providerId} (HCS seq ${seq})`);
    await this.follower.syncThrough(seq);
    const view = viewJob(this.follower.messages, jobKey, this.referee());
    const won = view.winner?.seq === seq;
    const key = entity.entityKey;
    if (won) {
      await this.wallet.patchEntity(ClaimSchema, key, { set: { status: 'WON', seq: u64(seq) } });
      await this.wallet.extendEntity({ entityKey: key, expiration: ExpirationTime.atDate(new Date(Date.now() + WINNER_HOLD_S * 1000)) });
    } else {
      await this.wallet.patchEntity(ClaimSchema, key, { set: { status: 'LOST', seq: u64(seq) } });
    }
    this.log(won ? `WON (seq ${seq})` : `lost to seq ${view.winner?.seq} (${view.claims.find((c) => c.seq === seq)?.reason ?? 'later'})`);
    return { won, round, seq, claimKey: key, view };
  }

  private async waitForJob(jobKey: string, until: (j: any) => boolean, timeoutMs = 300_000) {
    const start = Date.now();
    for (;;) {
      const j = await this.api.job(jobKey);
      if (until(j)) return j;
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for job');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  /** Full flow: claim → (if winner) pay → result. Losers wait and receive the winner's result. */
  async buy(audioUrl: string, choose: (s: ServiceRow[]) => ServiceRow | Promise<ServiceRow>): Promise<BuyOutcome> {
    const job = await this.jobFor(audioUrl);
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.view(job.jobKey);
      if (['PAID', 'DONE', 'REFUNDED'].includes(current.status)) {
        const j = await this.waitForJob(job.jobKey, (x) => ['DONE', 'REFUNDED'].includes(x.status));
        return { kind: 'PAID_BY_OTHER', jobKey: job.jobKey, round: j.round, result: j.intent?.result, winner: current.winner?.agent ?? '' };
      }
      const svc = await choose(await this.discover());
      const c = await this.claim(job.jobKey, svc);
      if (!c.won) {
        const j = await this.waitForJob(job.jobKey, (x) => ['DONE', 'REFUNDED'].includes(x.status) || x.round > c.round);
        if (j.round > c.round) continue; // winner's payment was proven VOID → next round
        return { kind: 'PAID_BY_OTHER', jobKey: job.jobKey, round: j.round, result: j.intent?.result, winner: c.view.winner?.agent ?? '' };
      }
      const out = await this.payLoop(job, c.round, c.claimKey);
      if (out) return out;
    }
    return { kind: 'FAILED', jobKey: job.jobKey, reason: 'too many rounds' };
  }

  private async payLoop(job: { jobKey: string; audioUrl: string; inputHash: string }, round: number, claimKey: `0x${string}`): Promise<BuyOutcome | null> {
    for (;;) {
      const r = await this.api.pay({ jobKey: job.jobKey, round, audioUrl: job.audioUrl, inputHash: job.inputHash });
      const status = r.body?.status;
      if (r.http === 200) {
        await this.wallet.patchEntity(ClaimSchema, claimKey, { set: { status: 'PAID', tx: String(r.body.intent?.txId ?? '-') } });
        await this.wallet.extendEntity({ entityKey: claimKey, expiration: ExpirationTime.atDate(new Date(Date.now() + 86_400_000)) });
        return { kind: 'PAID_BY_ME', jobKey: job.jobKey, round, result: r.body.result, intent: r.body.intent };
      }
      if (r.http === 202 && status === 'APPROVAL_REQUIRED') {
        this.log('over cap → waiting for human approval (World ID)', r.body.verificationUriComplete);
        this.opts.onApproval?.(r.body);
        await new Promise((res) => setTimeout(res, 5000));
        continue; // re-call pay: it consumes the approval once APPROVED
      }
      if (r.http === 202) {
        this.log(`payment ${status} → waiting for the resolver (death clock)`);
        await this.wallet.patchEntity(ClaimSchema, claimKey, { set: { status: 'PAYING', tx: String(r.body.intent?.txId ?? '-') } });
        const j = await this.waitForJob(job.jobKey, (x) => ['DONE', 'REFUNDED', 'PAID'].includes(x.status) || x.round > round);
        if (j.round > round) {
          await this.wallet.patchEntity(ClaimSchema, claimKey, { set: { status: 'VOID' } });
          this.log('proven VOID → next round');
          return null;
        }
        const done = await this.waitForJob(job.jobKey, (x) => ['DONE', 'REFUNDED'].includes(x.status));
        return { kind: 'PAID_BY_ME', jobKey: job.jobKey, round, result: done.intent?.result, intent: done.intent };
      }
      if (r.http === 409 && r.body?.error?.code === 'ROUND_CLOSED') return null;
      return { kind: 'FAILED', jobKey: job.jobKey, reason: `${r.http} ${JSON.stringify(r.body)}` };
    }
  }

  close() {
    this.hedera?.close();
  }
}
```

**File: `packages/agent-kit/src/index.ts`**

```ts
export * from './agent';
export * from './api';
export * from './identity';
```

**Exit checks** (first real end-to-end payment!)

- [ ] Link one agent (`pnpm --filter @forkos/agents link "Agent A"`, P25), then run P37's runner with one agent → `PAID_BY_ME`, transcript + summary printed, HashScan shows FUSD from the **budget account** to the provider with memo `forkos:<job>:r0`
- [ ] Arkiv explorer: the agent's claim `PAID`, owned by the agent's address
- [ ] HCS (Mirror): `CLAIM` (payer = agent account) → `INTENT` → `SETTLED` → `DONE`

**Commit:** `feat(agent-kit): agent identity, arkiv+HCS claims, referee reading, pay loop, loser gets winner's result`

---

### Phase P36 — `forkos-mcp`: a safe pay tool for any MCP agent

**Goal:** Claude Desktop / Cursor / any MCP client gets three tools. The agent never holds payment keys — it
holds only its agent key (claims) and agent token. **Time:** 35 min. **Depends:** P35.

**File: `apps/mcp/src/index.ts`**

```ts
#!/usr/bin/env -S npx tsx
// stdio MCP server. NEVER write to stdout except via the MCP transport (use console.error for logs).
import { ForkosAgent } from '@forkos/agent-kit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`forkos-mcp: missing ${k}`);
  return v;
};

const agent = await new ForkosAgent({
  key: need('FORKOS_AGENT_KEY') as `0x${string}`,
  token: need('FORKOS_AGENT_TOKEN'),
  apiUrl: need('FORKOS_API_URL'),
  arkivAccessKey: need('ARKIV_ACCESS_KEY'),
  log: (m, e) => console.error(`[forkos] ${m}`, e ?? ''),
}).init();

const server = new McpServer({ name: 'forkos', version: '0.1.0' });
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o, null, 2) }] });

server.registerTool(
  'forkos_whoami',
  { title: 'ForkOS identity', description: 'Shows this agent, its human (hash), Hedera account and authority epoch.' },
  async () => text(await agent.api.me()),
);

server.registerTool(
  'forkos_services',
  { title: 'Paid services', description: 'Lists x402 transcription services from the public Arkiv directory with prices.' },
  async () => text((await agent.discover()).map((s) => ({ providerId: s.providerId, name: s.name, price: s.price.toString(), endpoint: s.endpoint }))),
);

server.registerTool(
  'forkos_buy_transcription',
  {
    title: 'Buy a transcription (exactly once)',
    description:
      'Transcribes and summarizes an audio URL through a paid x402 service. ForkOS guarantees your human pays at most once for the same audio, even if other agents of the same human try too. Over-cap payments ask the human on their phone.',
    inputSchema: { audioUrl: z.string().url(), providerId: z.string().optional() },
  },
  async ({ audioUrl, providerId }) => {
    const out = await agent.buy(audioUrl, (services) => {
      const pick = providerId ? services.find((s) => s.providerId === providerId) : [...services].sort((a, b) => (a.price < b.price ? -1 : 1))[0];
      if (!pick) throw new Error('no matching service in the directory');
      return pick;
    });
    return text(out);
  },
);

await server.connect(new StdioServerTransport());
```

**Claude Desktop config** (`claude_desktop_config.json`) — use absolute paths:

```json
{
  "mcpServers": {
    "forkos": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/forkos/apps/mcp/src/index.ts"],
      "env": {
        "FORKOS_API_URL": "https://<api-domain>",
        "FORKOS_AGENT_KEY": "0x…",
        "FORKOS_AGENT_TOKEN": "fat_…",
        "ARKIV_ACCESS_KEY": "ak_…"
      }
    }
  }
}
```

Link this agent first with `pnpm --filter @forkos/agents link "Claude Desktop"` and copy its key/token from
`.secrets/agents.json`.

**Exit checks**

- [ ] Claude Desktop lists `forkos_whoami`, `forkos_services`, `forkos_buy_transcription`
- [ ] "Transcribe <SAMPLE_AUDIO_URL>" → tool returns `PAID_BY_ME` (or `PAID_BY_OTHER` if another agent already bought it — **that is the cross-platform dedupe moment**)

**Commit:** `feat(mcp): forkos-mcp — whoami, services, exactly-once buy_transcription`

---

### Phase P37 — Demo agents (ForkOS lane, real LLM decisions)

**Goal:** N linked agents race on the same job. Each one is a real LLM agent with a different persona that
chooses a service from the Arkiv directory. **Time:** 40 min. **Depends:** P35.

**File: `apps/agents/src/choose.ts`**

```ts
import type { ServiceRow } from '@forkos/shared';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Real LLM decision: pick one providerId from the directory, given a persona. */
export async function llmChoose(persona: string, services: ServiceRow[]): Promise<ServiceRow> {
  const list = services.map((s) => ({ providerId: s.providerId, name: s.name, priceFUSD: Number(s.price) / 1e6 }));
  const res = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `You are a procurement agent. ${persona} Reply as JSON {"providerId": "...", "why": "..."}.` },
      { role: 'user', content: `Task: transcribe and summarize a meeting recording. Services: ${JSON.stringify(list)}` },
    ],
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}') as { providerId?: string; why?: string };
  const pick = services.find((s) => s.providerId === parsed.providerId) ?? services[0]!;
  console.log(`  LLM (${persona.slice(0, 24)}…) chose ${pick.providerId}: ${parsed.why ?? ''}`);
  return pick;
}

export const PERSONAS = [
  'You always pick the cheapest option.',
  'You prefer the provider whose name sounds most reliable; price matters less.',
  'You prefer the premium option when the meeting might be important.',
];
```

**File: `apps/agents/src/run.ts`**

```ts
// Usage: pnpm agents [count]   → races the linked agents in .secrets/agents.json on the sample meeting
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForkosAgent, ForkosApi } from '@forkos/agent-kit';
import { llmChoose, PERSONAS } from './choose';

const store = JSON.parse(readFileSync(join(process.cwd(), '..', '..', '.secrets', 'agents.json'), 'utf8')) as Record<
  string,
  { key: `0x${string}`; token?: string }
>;
const linked = Object.entries(store).filter(([, v]) => v.token);
const count = Number(process.argv[2] ?? linked.length);
const apiUrl = process.env.FORKOS_API_URL ?? 'http://localhost:4000';
const since = Math.floor(Date.now() / 1000) - 5;

const job = await new ForkosApi(apiUrl).demoJob(process.env.DEMO_KEY!);
console.log('job audio:', job.audioUrl, job.inputHash);

const results = await Promise.all(
  linked.slice(0, count).map(async ([label, v], i) => {
    const agent = await new ForkosAgent({ key: v.key, token: v.token!, apiUrl, arkivAccessKey: process.env.ARKIV_ACCESS_KEY! }).init();
    const out = await agent.buy(job.audioUrl, (services) => llmChoose(PERSONAS[i % PERSONAS.length]!, services));
    agent.close();
    return { label, kind: out.kind };
  }),
);
console.table(results);

const anyAgent = linked[0]![1];
const api = new ForkosApi(apiUrl, anyAgent.token);
const me = await api.me();
const { jobKeyOf } = await import('@forkos/shared');
const jobKey = jobKeyOf(me.humanHash, job.inputHash);
console.log('Mirror Node counter:', JSON.stringify((await api.counter(jobKey, since)).forkos));
```

**Exit checks**

- [ ] Link 3 agents (`Agent A/B/C`), run `pnpm agents 3` → exactly **one** `PAID_BY_ME`, two `PAID_BY_OTHER`
- [ ] Counter: `forkos.payments: 1` (from Mirror Node)
- [ ] Run it again with the same audio → all three `PAID_BY_OTHER`, counter still `1` (paid once, forever)

**Commit:** `feat(agents): ForkOS-lane demo — real LLM agents race one job, exactly one payment`

---

### Phase P38 — Baseline lane (how agents pay today)

**Goal:** the honest comparison: three independent agents, **each with its own wallet** and the standard x402
client (`@x402/fetch`), each choosing a provider with the same LLM personas, calling the stock endpoint.
Standard x402 does not know these are the same job, so each pays. **Time:** 30 min. **Depends:** P22.

**File: `apps/agents/src/baseline.ts`**

```ts
// Usage: pnpm baseline     → 3 independent agents, own wallets, stock x402 client, same meeting
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForkosApi } from '@forkos/agent-kit';
import { loadDeployments, parsePrivateKey, type ServiceRow } from '@forkos/shared';
import { x402Client } from '@x402/core/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { llmChoose, PERSONAS } from './choose';

const dep = loadDeployments();
const secrets = JSON.parse(readFileSync(join(process.cwd(), '..', '..', '.secrets', 'testnet-keys.json'), 'utf8'));
const apiUrl = process.env.FORKOS_API_URL ?? 'http://localhost:4000';
const api = new ForkosApi(apiUrl);
const since = Math.floor(Date.now() / 1000) - 5;
const job = await api.demoJob(process.env.DEMO_KEY!);
const services = (await api.directory()).services.map((s) => ({ ...s, price: BigInt(s.price) })) as unknown as ServiceRow[];

const runs = await Promise.all(
  dep.baselineAgents.map(async (accountId, i) => {
    const signer = createClientHederaSigner(accountId, parsePrivateKey(secrets.baselineAgents[accountId]), { network: 'hedera:testnet' });
    const client = new x402Client().register('hedera:*', new ExactHederaScheme(signer)).setSpendControls(false);
    const pay = wrapFetchWithPayment(fetch, client);
    const svc = await llmChoose(PERSONAS[i % PERSONAS.length]!, services);
    const url = svc.endpoint.replace(/\/v1\/jobs$/, '/v1/baseline/jobs');
    const res = await pay(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) });
    const header = res.headers.get('PAYMENT-RESPONSE');
    const settle = header ? decodePaymentResponseHeader(header) : null;
    return { agent: accountId, provider: svc.providerId, status: res.status, tx: settle?.transaction ?? '-' };
  }),
);
console.table(runs);
console.log('Each independent agent paid. Standard x402 dedupes retries of ONE request, not one job across agents.');
console.log('Mirror counter (baseline lane, since start):');
const counterJob = '0'.repeat(64); // baseline lane does not depend on jobKey
console.log(JSON.stringify((await api.counter(counterJob, since)).baseline));
```

**Exit checks**

- [ ] `pnpm baseline` → 3 rows with status `200` and 3 distinct tx ids; Mirror counter `baseline.payments: 3`
- [ ] Each tx opens on HashScan (3 × FUSD paid for one meeting)

**Commit:** `feat(agents): baseline lane — independent agents with stock x402 pay three times for one job`

---

### Phase P39 — Chaos panel: "Try to make us pay twice"

**Goal:** demo endpoints the judge presses (dashboard buttons): kill the payer mid-flight, replay an old
payment, revive a fired agent, force a job failure after payment (refund). **Time:** 45 min. **Depends:** P30–P34.

Add a fail flag to **`services/api/src/chaosState.ts`** (final version):

**File: `services/api/src/chaosState.ts`**

```ts
let killNext = false;
let failNext = false;

export const chaos = {
  armKill() {
    killNext = true;
  },
  takeKill(): number | null {
    if (!killNext) return null;
    killNext = false;
    return 400; // abort the HTTP call 400 ms after sending: payment may or may not have settled
  },
  armFail() {
    failNext = true;
  },
  takeFail(): boolean {
    const v = failNext;
    failNext = false;
    return v;
  },
};
```

In **`services/api/src/payer.ts`** `sendIntent`, add the fail header to `headers`:

```ts
    ...(chaos.takeFail() ? { 'x-forkos-chaos-fail': '1' } : {}),
```

**File: `services/api/src/routes/chaos.ts`**

```ts
import { ApiError, H_AGENT, H_CLAIM, H_JOB, H_ROUND, listServices } from '@forkos/shared';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireDemo } from '../auth';
import { chaos } from '../chaosState';
import { arkivPub } from '../clients';
import { env } from '../config';
import { sql, type IntentRow } from '../db';
import { emit } from '../events';
import { jobView } from '../views';

const facilitator = new HTTPFacilitatorClient({ url: env.FACILITATOR_URL });

export function registerChaosRoutes(app: FastifyInstance) {
  app.post('/v1/chaos/kill-next-payer', async (req) => {
    requireDemo(req);
    chaos.armKill();
    await emit('chaos', { kind: 'kill-next-payer', detail: 'next payment HTTP call is aborted 400 ms after sending' });
    return { armed: true };
  });

  app.post('/v1/chaos/fail-next-job', async (req) => {
    requireDemo(req);
    chaos.armFail();
    await emit('chaos', { kind: 'fail-next-job', detail: 'next job fails after payment → HTS refund' });
    return { armed: true };
  });

  app.post<{ Params: { intentId: string } }>('/v1/chaos/replay/:intentId', async (req) => {
    requireDemo(req);
    const [i] = await sql<IntentRow[]>`select * from intents where id = ${req.params.intentId}`;
    if (!i) throw new ApiError('NOT_FOUND', 'unknown intent');
    const settle = await facilitator.settle(i.payment_payload as unknown as PaymentPayload, i.requirements as unknown as PaymentRequirements);
    await emit('chaos', { kind: 'replay', detail: { intentId: i.id, txId: i.tx_id, success: settle.success, reason: settle.errorReason } });
    return { facilitator: settle };
  });

  app.post<{ Params: { agentAddr: string } }>('/v1/chaos/revive/:agentAddr', async (req) => {
    requireDemo(req);
    const { jobKey } = z.object({ jobKey: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.body);
    const agentAddr = req.params.agentAddr.toLowerCase();
    const view = await jobView(jobKey);
    const claim = [...view.claims].reverse().find((c) => c.agent === agentAddr);
    if (!claim) throw new ApiError('NOT_FOUND', 'this agent has no claim on that job');
    const svc = (await listServices(arkivPub)).find((s) => s.providerId === claim.svc);
    if (!svc) throw new ApiError('NOT_FOUND', 'service not in directory');
    const res = await fetch(svc.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [H_JOB]: jobKey, [H_ROUND]: String(view.round), [H_AGENT]: agentAddr, [H_CLAIM]: claim.arkivKey },
      body: JSON.stringify({ audioUrl: env.SAMPLE_AUDIO_URL, inputHash: 'sha256:' + '0'.repeat(64) }),
    });
    const body = await res.json().catch(() => ({}));
    await emit('chaos', { kind: 'revive', detail: { agentAddr, status: res.status, body } });
    return { provider: { status: res.status, body } };
  });
}
```

**Demo scenarios this enables** (rehearse each twice):

| Button | Judge sees |
|---|---|
| Kill payer | intent → `PAYMENT_UNKNOWN`, **death clock** counts down on the dashboard, then `PAID` (found on Mirror) or `VOID` (proven) → next round → still **1** payment |
| Replay | facilitator answers `forkos_replay_detected` (and P15 showed the network's own `DUPLICATE_TRANSACTION`) |
| Revive fired agent | revoke an agent (World), then revive → provider `409 STALE_AUTHORITY` / `NOT_WINNER` |
| Fail next job | job fails after payment → `refund.sent`, HashScan shows the FUSD refund, HCS `REFUND` |

**Exit checks**

- [ ] Each button produces the outcome in the table and a `chaos` SSE event
- [ ] After all chaos, `/v1/counter` for the job still shows `forkos.payments: 1`

**Commit:** `feat(api): chaos panel — kill payer, replay, revive fired agent, fail-after-payment refund`

---

### Phase P40 — `forkos audit`: anyone can verify from Mirror Node

**Goal:** a CLI that rebuilds every job from the HCS topic and re-checks each claim of payment against the
ledger — no access to our servers. **Time:** 45 min. **Depends:** P9.

Checks per job:

| Check | Pass condition |
|---|---|
| A1 one payment | at most one `SETTLED` across all rounds (referee guarantees ≤1 per open round; audit checks all) |
| A2 settled is real | `SETTLED.tx` is `SUCCESS` on Mirror Node, memo `forkos:<jobShort>:r<round>`, token leg = `INTENT.amt` to `INTENT.payTo` |
| A3 voids are proven | each `VOID.tx` (≠ `none`) returns 404 on Mirror Node and `now > INTENT.dl + 45 s` |
| A4 winner paid | `INTENT.agent` = the referee winner of that round |
| A5 refunds are real | each `REFUND.rtx` is `SUCCESS` on Mirror Node |

**File: `apps/cli/src/audit.ts`**

```ts
import { Mirror, VOID_MARGIN_S, jobKeysIn, jobShort, readTopic, viewJob, type Decoded } from '@forkos/shared';

type Check = { job: string; check: string; ok: boolean; detail: string };

export async function audit(opts: { topic: string; operator: string; providers: string[]; mirrorUrl?: string; job?: string }) {
  const mirror = new Mirror(opts.mirrorUrl);
  const messages: Decoded[] = await readTopic(mirror, opts.topic);
  const jobs = opts.job ? [opts.job] : jobKeysIn(messages);
  const checks: Check[] = [];
  const nowS = Date.now() / 1000;

  for (const job of jobs) {
    const view = viewJob(messages, job, { operatorId: opts.operator, providerAccounts: opts.providers });
    const forJob = messages.filter((d) => d.msg && 'job' in d.msg && d.msg.job === job && d.payer === opts.operator);
    const settled = forJob.filter((d) => d.msg!.t === 'SETTLED');
    const intents = forJob.filter((d) => d.msg!.t === 'INTENT');
    checks.push({ job, check: 'A1 one payment', ok: settled.length <= 1, detail: `${settled.length} SETTLED` });

    for (const s of settled) {
      const m = s.msg as Extract<NonNullable<Decoded['msg']>, { t: 'SETTLED' }>;
      const intent = intents.map((d) => d.msg as Extract<NonNullable<Decoded['msg']>, { t: 'INTENT' }>).find((i) => i.tx === m.tx);
      const tx = await mirror.getTransaction(m.tx);
      const memoOk = tx.found && tx.memo === `forkos:${jobShort(job)}:r${m.round}`;
      const leg = tx.found ? (tx.tx.token_transfers ?? []).find((t) => t.account === intent?.payTo && t.amount > 0) : undefined;
      const ok = tx.found && tx.success && memoOk && !!intent && !!leg && String(leg.amount) === intent.amt;
      checks.push({ job, check: 'A2 settled is real', ok, detail: `${m.tx} ${tx.found ? tx.result : 'NOT FOUND'} memo=${memoOk}` });
    }

    for (const d of forJob.filter((x) => x.msg!.t === 'VOID')) {
      const m = d.msg as Extract<NonNullable<Decoded['msg']>, { t: 'VOID' }>;
      if (m.tx === 'none') {
        checks.push({ job, check: 'A3 void proven', ok: !intents.some((i) => (i.msg as { round: number }).round === m.round), detail: `round ${m.round} abandoned` });
        continue;
      }
      const intent = intents.map((x) => x.msg as Extract<NonNullable<Decoded['msg']>, { t: 'INTENT' }>).find((i) => i.tx === m.tx);
      const tx = await mirror.getTransaction(m.tx);
      const ok = (!tx.found || !tx.success) && !!intent && nowS > intent.dl + VOID_MARGIN_S;
      checks.push({ job, check: 'A3 void proven', ok, detail: `${m.tx} ${tx.found ? tx.result : 'not on ledger'}; deadline ${intent?.dl}` });
    }

    if (view.intent) checks.push({ job, check: 'A4 winner paid', ok: view.intent.agent === view.winner?.agent, detail: `winner ${view.winner?.agent}` });
    if (view.refund) {
      const r = await mirror.getTransaction(view.refund.rtx);
      checks.push({ job, check: 'A5 refund real', ok: r.found && r.success, detail: view.refund.rtx });
    }
  }
  return { jobs: jobs.length, checks, ok: checks.every((c) => c.ok) };
}
```

**File: `apps/cli/src/index.ts`**

```ts
#!/usr/bin/env -S npx tsx
import { Mirror } from '@forkos/shared';
import { Command } from 'commander';
import { audit } from './audit';

const program = new Command().name('forkos').description('Verify ForkOS agent payments from Hedera Mirror Node');

program
  .command('audit')
  .requiredOption('--topic <id>', 'ForkOS HCS topic id')
  .requiredOption('--operator <id>', 'ForkOS operator account (publisher of INTENT/SETTLED/VOID)')
  .option('--providers <ids>', 'comma-separated provider accounts (for REFUND)', '')
  .option('--job <jobKey>', 'only this job')
  .option('--mirror <url>', 'Mirror Node base URL', 'https://testnet.mirrornode.hedera.com')
  .action(async (o) => {
    const r = await audit({ topic: o.topic, operator: o.operator, providers: o.providers ? o.providers.split(',') : [], mirrorUrl: o.mirror, job: o.job });
    for (const c of r.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.job.slice(0, 16)}  ${c.check.padEnd(20)} ${c.detail}`);
    console.log(`\n${r.jobs} jobs, ${r.checks.length} checks — ${r.ok ? 'ALL PASSED' : 'VIOLATIONS FOUND'}`);
    process.exit(r.ok ? 0 : 1);
  });

program
  .command('intent <txId> <deadline>')
  .description('Resolve one payment intent: PAID, FAILED, VOID or UNKNOWN')
  .action(async (txId: string, deadline: string) => {
    const { resolveIntent } = await import('../../../packages/x402-hedera/src/resolver');
    console.log(await resolveIntent(new Mirror(), txId, Number(deadline)));
  });

await program.parseAsync();
```

**Commands**

```bash
pnpm forkos audit --topic $HCS_TOPIC_ID --operator $OPERATOR_ID --providers 0.0.A,0.0.B,0.0.C
```

**Exit checks**

- [ ] After P37 + P39 runs: every line `✓`, `ALL PASSED`
- [ ] Put this exact command in the README ("verify us yourself, no setup but Node")

**Commit:** `feat(cli): forkos audit — rebuild every job from HCS and re-check each payment on Mirror Node`

---

### Phase P41 — The x402 extension spec (+ upstream PR)

**Goal:** turn the core idea into a short spec others can implement — the pattern that won Hedera's last x402
bounty (Tally contributed a scheme upstream). **Time:** 30 min. **Depends:** P15.

**File: `docs/spec/x402-hedera-payment-intents.md`**

```markdown
# Payment intents for x402 `exact` on Hedera (death clock)

Status: draft, implemented by ForkOS (`@forkos/x402-hedera`). Compatible with the existing `exact` Hedera scheme —
facilitators and resource servers need no changes.

## Problem
An x402 client that loses the response to a paid request cannot tell whether it paid. Retrying risks paying twice;
not retrying risks never receiving the resource. Request-level idempotency keys do not prove that a lost payment
will not settle later.

## Mechanism (client-side, spec-compatible)
1. The client sets `transactionId = (extra.feePayer, validStart)` itself, with `validStart = now - 5 s`,
   `transactionValidDuration = 120 s`, and an application memo.
2. The client persists `{txId, validStart, deadline = validStart + 120 s, signed bytes}` **before** sending.
3. Retries resend the **identical bytes** while `now < deadline - 10 s`. The client never re-signs while the outcome
   is unknown.
4. Resolution: query the Mirror Node for `txId`.
   - result `SUCCESS` → PAID
   - other result → FAILED (consensus reached, value did not move)
   - not found and `now > deadline + 45 s` → VOID: the bytes are expired network-wide and can never execute.

## Why it is sound on Hedera
- Duplicate transaction ids are rejected (`DUPLICATE_TRANSACTION`) for the receipt period.
- Expired transactions are rejected (`TRANSACTION_EXPIRED`) when `validStart + validDuration` < consensus time.
- Consensus and Mirror Node availability are seconds, so the margin is small and the proof is cheap.

## Facilitator recommendations
- Keep a persistent replay table keyed by `txId` (reject while SETTLING or after SETTLED).
- Reject payloads with `transactionValidDuration > 120` or that are already expired.

## Reference implementation
`createIntentSigner`, `buildIntentPayment`, `resolveIntent` in `packages/x402-hedera`. Testnet evidence in `docs/proof.md`.
```

**Upstream PR (15 min, optional but high value):** fork `x402-foundation/x402`, add the spec as
`specs/extensions/hedera_payment_intents.md` (keep the text above), open a PR titled
"Hedera exact: client-side payment intents with a death clock (resolvable unknown outcomes)". Put the PR link in
the README.

**Commit:** `docs(spec): x402 hedera payment intents (death clock) extension`

---
### Phase P42 — Deploy to Railway + end-to-end on the deployed stack (**H2 handoff**)

**Goal:** facilitator, API and three providers live on public HTTPS URLs with one Postgres; the full flow runs
against them. **Time:** 60 min. **Depends:** everything above.

**Railway project layout** (one project, 6 services, all from the same GitHub repo, root directory = repo root):

| Service | Start command | Key variables (ICD-2) |
|---|---|---|
| Postgres | Railway Postgres plugin | gives `DATABASE_URL` |
| `facilitator` | `pnpm --filter @forkos/facilitator start` | `DATABASE_URL`, `FACILITATOR_FEE_PAYER_ID/KEY`, `MIRROR_URL` |
| `scribe-a` | `pnpm --filter @forkos/provider start` | all provider vars, `PROVIDER_ID=scribe-a`, `PROVIDER_PUBLIC_URL=https://<scribe-a domain>`, `FACILITATOR_URL=https://<facilitator domain>` |
| `scribe-b` | same | `PROVIDER_ID=scribe-b`, its account/key/price/url |
| `scribe-premium` | same | `PROVIDER_ID=scribe-premium`, its account/key/price/url |
| `api` | `pnpm --filter @forkos/api start` | all api vars, `API_PUBLIC_URL`, `WEB_ORIGIN=<frontend url>`, `SAMPLE_AUDIO_URL=https://<scribe-a domain>/sample-meeting.mp3` |

Build settings for every service: **Build command** `corepack enable && pnpm install --frozen-lockfile`;
Node version via `NIXPACKS_NODE_VERSION=22` (or `engines` is enough on current Railway); generate a public domain
per service. Railway injects `PORT`; our `portFrom` prefers it.

**Commands**

```bash
git push                                     # Railway builds from main
DATABASE_URL=<railway public postgres url> pnpm db:migrate
curl -s https://<facilitator>/supported
curl -s https://<scribe-a>/health
curl -s https://<api>/v1/health
```

**End-to-end on the deployed stack** (this is your rehearsal):

```bash
export FORKOS_API_URL=https://<api domain>
pnpm --filter @forkos/agents link "Agent A"     # approve on phone
pnpm --filter @forkos/agents link "Agent B"
pnpm --filter @forkos/agents link "Agent C"
pnpm baseline                                   # expect 3 payments
pnpm agents 3                                   # expect exactly 1 payment
pnpm forkos audit --topic $HCS_TOPIC_ID --operator $OPERATOR_ID --providers <3 provider accounts>
```

**H2 handoff** — send the frontend owner: API URL, demo key, and confirm `WEB_ORIGIN` contains their URL.

**Exit checks**

- [ ] All 5 app services healthy; Arkiv directory shows the 3 **Railway** endpoints (not localhost)
- [ ] Baseline 3 payments, ForkOS 1 payment, audit ALL PASSED — against the deployed URLs
- [ ] Write every tx id / HashScan link into `docs/proof.md`

**Commit:** `chore(deploy): railway services + deployed end-to-end proof`

---

### Phase P43 — Arkiv judging files

**Goal:** the five files Arkiv judges read (each criterion is 25 %). Fill the `<>` with real numbers/links.
**Time:** 30 min. **Depends:** P42.

**File: `arkiv/schema.md`**

```markdown
# ForkOS on Arkiv — schema

| Entity (schema tag) | Owner (who can edit) | Indexed fields we query | Other fields | Expires |
|---|---|---|---|---|
| `forkos.service.v1` | each provider's wallet | providerId, capability, network, asset, price | name, endpoint, payTo | 24 h, refreshed every 6 h (dead services disappear) |
| `forkos.agentlink.v1` | ForkOS API wallet `<API_ARKIV_ADDRESS>` | human, agent, status, epoch | acct, label | 30 days, re-extended on every change |
| `forkos.claim.v1` | **the agent's own wallet** | job, round, human, agent, status | epoch, svc, price, seq, tx | 30 s if it loses; winner extends to 10 min, then 24 h once PAID (receipt) |

Writer wallets: API `<0x…>`, provider `<0x…>`, agents `<0x…>, <0x…>, <0x…>`.

Query you can run (claims for the demo job):
`select().from(forkos.claim.v1).where(eq("job","<jobKey>"))` — see `packages/shared/src/arkiv.ts#listClaims`.
```

**File: `arkiv/how-you-use-arkiv.md`**

```markdown
# How ForkOS uses Arkiv

- **Filters match real questions.** Agents ask "which transcription services exist and what do they cost?"
  (`capability`, `price`); providers ask "is this the live claim for job J, round R, owned by agent A?" (`job`, `round`,
  `agent`, `$owner`); dashboards ask "show me every claim on this job" (`job`).
- **Ownership is the security model.** A claim is owned by the agent that made it, so neither ForkOS nor another agent
  can forge or delete it. Service entries are owned by the provider. Agent links are owned by the API wallet, which only
  writes them after a World ID check.
- **Expiry is the death clock.** Losing claims vanish after 30 s. A winning claim lives while its payment can still
  settle; a payment that is proven void leaves no live claim. Services that stop refreshing drop out of the directory.
- **Every feature is visible:** the agents' service discovery, the dashboard's claim board and directory, and the
  provider's fence (it refuses jobs whose claim is not live on Arkiv) all read Arkiv.
```

**File: `arkiv/why-arkiv.md`**

```markdown
# Why Arkiv (and what we kept off it)

**If this were Postgres:** agents on different platforms (Claude Desktop, scripts, other companies' agents) would have
to trust our server to tell them who claimed what, and a provider would have to trust us that a request is the live
winner. With Arkiv, the claim is a public entity owned by the agent's own wallet that the provider reads directly —
ForkOS cannot fake a claim, hide one, or keep a dead one alive.

**Kept off Arkiv, deliberately:**
- *Ordering* (who claimed first) → Hedera Consensus Service, because a public database is not a mutex.
- *Money truth* (did it pay) → the Hedera ledger via Mirror Node.
- *Secrets* (budget keys, World tokens) → our backend only.
```

**File: `arkiv/reach.md`**

```markdown
# Reach

Anyone running AI agents that pay over x402 has this problem the first time a request times out or two agents act
on the same task. ForkOS ships as an npm wrapper (`@forkos/x402-hedera`), an MCP server (`forkos-mcp`) and a CLI.
Try it today: <live demo URL>. After Mumbai we will keep the claim/directory schema stable so other agent frameworks
can read and write the same entities.
```

**File: `arkiv/friction.md`** — your honest notes from P10/P16/P25 (what broke, what you expected, how to
reproduce, what would have helped). Write it as you go; aim for 5–10 concrete bullets.

**Commit:** `docs(arkiv): schema, usage, why-arkiv, reach, friction`

---

### Phase P44 — README, World debrief, AI disclosure

**Goal:** the README judges read first, with every sponsor requirement findable in seconds. **Time:** 45 min.
**Depends:** P42, P43.

**README section order** (write real values, no placeholders left):

1. **One line + 20-second explanation** ("Agents fork. Money doesn't." + the dropped-connection question).
2. **Live demo** URL, video link, `forkos audit` one-liner.
3. **Proof table** (from `docs/proof.md`): for each — HashScan link:
   ForkOS payment (1), baseline payments (3), replay rejected, `DUPLICATE_TRANSACTION`, `TRANSACTION_EXPIRED`,
   VOID proof, HTS refund, topic id, FUSD token id.
4. **Architecture** diagram (I.4 sequence) + the six safeguards table (I.2).
5. **The death clock** (I.3, the rule + why VOID is a proof).
6. **Sponsor sections**, each mapping requirement → file/line:
   - *Hedera x402* — endpoint (`services/provider/src/routes.ts`), facilitator (`services/facilitator`), agent finds it
     (Arkiv directory → `packages/agent-kit`), settled tx id, extras (policy, HCS log, negotiation, HTS).
   - *Hedera No Solidity* — zero `.sol` files; HCS + HTS + Mirror Node usage list.
   - *World Agent Pass* — the three protected actions, the denied paths D1–D5, backend validation (`services/api/src/world.ts`), link to `docs/world-debrief.md`.
   - *Arkiv* — link to `/arkiv/*.md`, writer wallets, one query.
7. **Setup** (P1 → P15 commands condensed) and **how to run the demo**.
8. **Limitations (honest):** testnet only; budget keys are custodial in the API (Hedera Agent Accounts would replace this);
   World mock identities are test-only; a refunded job is final in this MVP; the provider set is ours (third-party
   sellers work for payment, but only fenced providers protect execution).
9. **AI tools disclosure** (ETHGlobal rule) — which parts were AI-assisted; planning docs in `docs/planning/`.
10. **Licence** MIT.

Complete `docs/world-debrief.md` (P4 skeleton): time to first success, friction (e.g. device vs browser flow,
mock `sub` behaviour you observed), missing docs/capability, the one improvement with the greatest impact.

Copy this build doc and the original README into `docs/planning/`.

**Exit checks**

- [ ] A teammate who has not seen the code finds every sponsor requirement in the README in under 2 minutes
- [ ] Every link opens; no `<…>` placeholders remain

**Commit:** `docs: README with proof table, sponsor mapping, limitations, AI disclosure; world debrief`

---

### Phase P45 — Demo runbook (4-minute finalist demo + 2–4 min video)

**Goal:** a rehearsed script where every click is pre-tested. **Time:** 45 min incl. 2 rehearsals.
**Depends:** P42, frontend H2.

**Before going on stage:** owner logged in on the dashboard; 3 agents linked (one is Claude Desktop via MCP); a
**fresh audio URL** prepared (any second mp3, so the job is new); phone with World app unlocked; HashScan tab open
on the topic; `DEMO_KEY` set in the dashboard.

| Time | Say | Do | Screen shows |
|---|---|---|---|
| 0:00–0:25 | "Your agent sent a payment and the Wi-Fi died. Did it pay? Nobody can answer that today." | — | title |
| 0:25–1:05 | "Today: three agents, each with a wallet, same meeting." | click **Run baseline** | baseline lane: **3 payments**, 3 HashScan links |
| 1:05–1:50 | "Same three agents with ForkOS — one is Claude Desktop, two are scripts. They've never met; World ID knows they're the same human." | click **Run ForkOS** (+ ask Claude Desktop to transcribe the same URL) | claims on Arkiv, HCS order, 1 winner, **counter = 1** (Mirror Node) |
| 1:50–2:40 | "Now try to make us pay twice." Hand the laptop over. | **Kill payer** on a new job | `PAYMENT_UNKNOWN`, death clock → PAID or VOID → counter still 1 |
| 2:40–3:10 | "Replay the old payment." / "Revive a fired agent." | **Replay**, revoke agent (phone), **Revive** | `forkos_replay_detected`; provider `409 STALE_AUTHORITY` |
| 3:10–3:35 | "Expensive service? A human approves that exact payment." | premium job | phone World approval → paid; replayed approval refused |
| 3:35–4:00 | "Don't trust us — verify." | run `forkos audit` | all ✓ · "npm, MCP, CLI — any agent gets exactly-once payments." |

**Video (2–4 min):** record the same script at ≥ 720p with your own voice, no speed-up, no music-only sections.

**Commit:** `docs: demo runbook`

---

### Phase P46 — Freeze (Sat 04:00 IST)

**Goal:** stop changing behaviour; tag what judges can reproduce. **Time:** 15 min.

```bash
pnpm typecheck && pnpm test
git tag -a v1.0.0 -m "ForkOS — ETHGlobal Mumbai submission"
git push origin v1.0.0
```

**Rules after freeze:** no schema/contract-of-API changes; only bug fixes, docs, video. Do **not** re-run
`bootstrap:hedera` (it would change token/topic ids referenced everywhere).

**Exit checks**

- [ ] Tag pushed; `git status` clean; Railway is on the tagged commit
- [ ] Submission form: project, repo, video, live demo, **partner prizes = Hedera, World, Arkiv**, AI disclosure

---

## Part IV — Threat model → test mapping

| # | Threat | Mitigation | Evidence / test |
|---|---|---|---|
| T1 | Two agents of the same human buy the same thing | jobKey = H(human, capability, input); HCS first-valid-claim wins; payer pays only the winner; one intent per (job, round) | referee tests (P9); P37 run: counter = 1 |
| T2 | Payment response lost → blind retry pays twice | intent stored before send; resend same bytes only; network dedupe; facilitator replay table | P15 (2), (3); P39 kill payer |
| T3 | Unknown outcome never resolved / guessed | death clock: PAID via Mirror, VOID only after deadline + 45 s with a 404 | resolver tests (P15); P39 kill payer |
| T4 | Old signed bytes executed later (malicious facilitator) | 120 s validity; network rejects expired | P15 (4) `TRANSACTION_EXPIRED` |
| T5 | Fired/crashed agent acts with stale authority | epoch on HCS + Arkiv AgentLink; tokens revoked; provider fence F5/F6; payer checks epoch | P26 checks; P39 revive → 409 |
| T6 | Agent claims for another human / forged claim | claim payer must be the agent's linked account; Arkiv claim owned by agent; `jobKey` must match the agent's human | referee tests (payer mismatch, wrong human); P30 400 |
| T7 | Fake LINK/INTENT/VOID messages on the public topic | referee only accepts them when `payer == operator` | referee test "LINK not paid by operator" |
| T8 | Provider runs a job without being paid, or twice | verify → record → settle → run; partial unique index per (provider, job); re-fence after settle | P18 order; `prov_jobs_one_exec` |
| T9 | Paid but job failed | provider refunds in HTS + `REFUND` on HCS; reconciler for crashes | P39 fail-next-job; audit A5 |
| T10 | Over-spending | allowlist, daily cap, autonomous cap → World approval bound to exact digest, consumed in the intent transaction | P27 tests; P31 checks |
| T11 | Replayed World approval / wrong human approves | digest binding, one-use, TTL; pinned `sub` → `access_denied`; backend `sub` re-check | P27 D3–D5 |
| T12 | Unvalidated identity result | `jose.jwtVerify` with JWKS, `iss`, `aud`, `exp`, `auth_time` freshness; secrets server-side only | P24 |
| T13 | Price/payee swapped between directory and challenge | re-quote check before signing | P30 step 6 |
| T14 | x402 client silently blocks FUSD | `setSpendControls(false)`; ForkOS policy enforces limits | P14 test 3 |
| T15 | Key leakage | keys AES-256-GCM at rest; tokens stored as peppered hashes; device codes encrypted; nothing secret on HCS/Arkiv | P23, P24 checks |

---

## Part V — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `All payment requirements were rejected by spendControls` | x402 client default spend controls | `.setSpendControls(false)` on every `x402Client` (P14, P38) |
| facilitator `invalid_exact_hedera_payload_preflight_failed` | payer has no FUSD, or payTo cannot receive the token | check balances on HashScan; accounts must be created with `setMaxAutomaticTokenAssociations(-1)` (P6) |
| `invalid_exact_hedera_payload_signature_invalid` | payer key ≠ on-chain key of the payer account | the budget/baseline key in DB/secrets does not belong to that account; re-create |
| `fee_payer_not_managed_by_facilitator` | requirements built against a different facilitator | provider `FACILITATOR_URL` must point to *our* facilitator; restart provider (it reads `/supported` at boot) |
| `extra.feePayer` missing in 402 | `initX402()` not awaited or facilitator down at provider boot | start facilitator first, restart provider |
| `forkos_intent_expired` on first send | clock skew or intent built long before sending | check machine time (NTP); never cache built intents |
| `INVALID_TRANSACTION_START` from network | local clock ahead of network | keep `VALID_START_BACKDATE_S = 5`; sync clock |
| two `@hiero-ledger/sdk` versions | dependency drift | `pnpm ls @hiero-ledger/sdk -r`; pin `2.90.1` everywhere, `pnpm install` |
| Mirror Node 404 right after success | Mirror lag (seconds) | resolver waits; never treat 404 as VOID before deadline + 45 s |
| HCS seq not visible for > 30 s | Mirror lag spike | raise `MIRROR_WAIT_TIMEOUT_MS` |
| Arkiv write fails "insufficient funds" | agent/provider/API wallet has no tGLM | faucet, or raise `AGENT_ARKIV_FUND_WEI` |
| Arkiv `InvalidExpiryError` | lifetime not a multiple of 2 s | use even seconds (`evenSeconds`), `ExpirationTime.atDate` |
| `eq('$key', key(...))` rejected | SDK build difference | use `pub.getEntity(key, ClaimSchema)` (P10 note) |
| provider 409 `NOT_WINNER` for the real winner | winner's Arkiv claim expired (approval took long) | agent must extend after winning (`WINNER_HOLD_S`, P35); check agent-kit patch/extend calls succeed |
| provider 409 `STALE_AUTHORITY` right after linking | Arkiv `AgentLink` write still pending | retry after a few seconds; fence fails closed on purpose |
| World poll stuck `PENDING` | not approved, or worker not running | check API logs for `world worker`; approval link must be opened on the phone |
| World `invalid_client` | wrong auth method or secret | client must use `client_secret_post`; re-copy secret |
| World `FAILED: auth_not_fresh` | server clock or slow approval | `WORLD_FRESH_SECONDS` (default 300); check clock |
| Every login creates a new human | mock identities return a new `sub` | `WORLD_SUB_STABLE=false` → pairing-code linking (P25) |
| SSE works locally, not on Railway | proxy buffering | we send `x-accel-buffering: no`; ensure the frontend uses the API domain directly |
| `postgres` returns strings for numbers | bigint columns | wrap with `BigInt()`/`Number()` (by design) |

---

## Part VI — Final checklist

**Hedera — AI Agents That Pay (x402)**

- [ ] x402 endpoint settling on testnet through our own facilitator — `services/provider`, `services/facilitator`
- [ ] Agent finds the endpoint (Arkiv directory) and pays end to end with no human (under cap)
- [ ] README: setup, architecture, payment flow, **settled Hedera tx id**
- [ ] Video ≤ 5 min (we do 2–4) with a HashScan link on screen
- [ ] Extras: policy + human approval above cap · HCS audit log · multi-agent negotiation · HTS settlement

**Hedera — No Solidity Allowed**

- [ ] Zero `.sol` files · JS SDK only · HCS + HTS (+ Mirror Node) · README + video

**World — Agent Pass**

- [ ] Official Agent Pass (OIDC device flow, our registered client)
- [ ] Full journey shown: request → phone → validated in backend → protected action (link / revoke / over-cap)
- [ ] Denied path shown (cancel, expire, wrong human, replayed approval)
- [ ] No client secret in frontend; ID token validated with JWKS
- [ ] `docs/world-debrief.md` complete

**Arkiv — Build on Arkiv**

- [ ] Writes with `@arkiv-network/sdk` to Rabdi; user-visible features read from Arkiv
- [ ] README: writer wallets + one query · `/arkiv/schema.md` + 4 criterion files · MIT · AI disclosure

**ETHGlobal**

- [ ] Steady commit history (one commit per phase) · AI attribution · planning docs in `docs/planning/`
- [ ] Video 2–4 min, ≥ 720p, own voice
- [ ] Submitted before **Sat 7 Nov 09:00 IST** with partner prizes **Hedera, World, Arkiv**

**Demo readiness**

- [ ] Baseline = 3 payments, ForkOS = 1, counter from Mirror Node
- [ ] Kill / replay / revive / fail-after-payment each rehearsed twice
- [ ] `forkos audit` → ALL PASSED on the live topic
