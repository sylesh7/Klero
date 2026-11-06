# ForkOS — the exactly-once layer for AI agent payments

> **Agents fork. Money doesn't.**
> ETHGlobal Mumbai 2026 · Hedera · World ID

Your agent sent a payment and the connection dropped. **Did it pay?**

Every agent wallet built so far stops *bad* payments — limits, allowlists, scam checks. None of them answer that
question. So agents either retry and pay twice, or give up and never deliver. It gets worse with parallel
sub-agents: your Claude agent and your Cursor agent can both buy the same transcription.

ForkOS makes an agent payment **settle at most once, ever — or be provably void.** There is no third state.

---

## Verify us yourself

No account, no setup beyond Node. This rebuilds every job from the public Hedera topic and re-checks each claim of
payment against the ledger — it never touches our servers:

```bash
npx tsx apps/cli/src/index.ts audit \
  --topic 0.0.11332888 \
  --operator 0.0.5899352 \
  --providers 0.0.11332881,0.0.11332882,0.0.11332883
```

| | |
|---|---|
| HCS topic (referee + audit log) | [`0.0.11332888`](https://hashscan.io/testnet/topic/0.0.11332888) |
| FUSD token (HTS, 6 dp) | [`0.0.11332887`](https://hashscan.io/testnet/token/0.0.11332887) |
| Facilitator fee payer | [`0.0.11332879`](https://hashscan.io/testnet/account/0.0.11332879) |

## Proof on Hedera testnet

Full raw output in [`docs/proof.md`](docs/proof.md). Nothing below is mocked.

| What | Evidence |
|---|---|
| **A settled x402 payment** | [`0.0.11332879@1793930653.855000000`](https://hashscan.io/testnet/transaction/1793930662.387795138) — 0.001 FUSD, on-chain `validDuration` **120 s** |
| **Replay refused by our facilitator** | `settle: false forkos_replay_detected` (before any network call) |
| **Replay refused by Hedera itself** | `DUPLICATE_TRANSACTION` on direct resubmission of the same bytes |
| **Expired intent refused** | `forkos_intent_expired` (facilitator) **and** `TRANSACTION_EXPIRED` (network) |
| **VOID is provable** | resolver returned `{ state: 'VOID', provedAtS: 1793930671 }` for an intent never sent |
| **Baseline: 3 payments for 1 meeting** | 0.04 + 2.00 + 2.00 FUSD from three independent agents, counted from Mirror Node |

The fee for that payment was paid by the **facilitator**, not the paying agent — agents need no HBAR.

## The death clock

Verified facts: in Hedera's x402 `exact` scheme the **client** builds the transfer and sets its transaction id, so
we know the id *before sending*. The network rejects a duplicate id, and rejects a transaction whose
`validStart + validDuration` is past consensus time.

```text
deadline = validStart + 120 s

state(intent) =
  PAID   if Mirror Node has the tx id with result SUCCESS         (any time)
  FAILED if Mirror Node has the tx id with a non-SUCCESS result   (money did not move)
  VOID   if now > deadline + 45 s AND Mirror Node returns 404      (can never execute again)
  UNKNOWN otherwise                                                (wait; never re-sign)
```

**Why VOID is a proof, not a guess:** after the deadline every node rejects those bytes as expired, and any copy
submitted before it would already have reached consensus and be visible on Mirror Node. 45 s covers ingestion. So a
404 after `deadline + 45 s` means the payment did not happen and *cannot* — not even if a malicious facilitator
still holds the signed bytes.

The intent is written to disk **before** it is sent. Retries resend the identical bytes and never re-sign.

## The six safeguards

| # | Safeguard | Enforced by | Where |
|---|---|---|---|
| S1 | Only a linked agent of *this* human can act for them | World ID device flow + HCS `LINK` | `services/api/src/world.ts`, `agents.ts` |
| S2 | One winner per job round, decided publicly | HCS consensus order | `packages/shared/src/referee.ts` |
| S3 | Agents never hold payment keys; the payer signs only for the HCS winner, within policy | API payer + row lock | `services/api/src/payer.ts` |
| S4 | A payment settles **at most once, ever**; unknown outcomes resolve to PAID or provably VOID | Hedera tx-id dedupe + expiry, Mirror Node, facilitator replay table | `packages/x402-hedera`, `services/facilitator` |
| S5 | A provider runs a job only for the live winner with current authority, after settlement | Fence reading HCS (winner + live link/epoch) | `services/provider/src/fence.ts` |
| S6 | Fire/replace and over-cap spending need a fresh human approval bound to that exact action | World ID step-up + action digest | `services/api/src/approvals.ts` |

## How one job runs

```text
discover services ────────────────────────────────▶ HCS SERVICE announcements (registered provider accounts)
jobKey = sha256(humanHash | capability | inputHash)   same for every agent of one human
submit CLAIM ─────────────────────────────────────▶ HCS seq 41    ← consensus order is the referee
   (another agent's claim lands at seq 42 and loses; it waits for the winner's result)
POST /v1/pay ──▶ check winner + epoch + policy
                 build intent (tx id known, 120 s clock), STORE IT, publish INTENT
                 provider: fence → verify → settle → re-fence → run
                 ◀── 200 {transcript, summary} + PAYMENT-RESPONSE
                 resolver: Mirror SUCCESS → publish SETTLED, then DONE
```

If the arrow back from the provider is lost: `PAYMENT_UNKNOWN` → resolver → Mirror Node → PAID (fetch the result
by tx id) or, after the clock, VOID → HCS `VOID` → round 1 opens. The losing agent never re-buys; it waits and
receives the winner's result.

## Sponsors

### Hedera — AI Agents That Pay: x402

| Requirement | Where |
|---|---|
| x402-protected endpoint settling on Hedera testnet | `services/provider/src/routes.ts` → `services/facilitator` (our own facilitator) |
| An agent that **finds** the endpoint and pays end to end, no human | HCS service directory → `packages/agent-kit/src/agent.ts`; under-cap payments have zero human steps |
| Hedera tx id of a settled payment | table above + [`docs/proof.md`](docs/proof.md) |
| Extra: spending controls + human approval above an amount | `services/api/src/policy.ts`, `approvals.ts` |
| Extra: HCS as a tamper-evident spending log | topic `0.0.11332888`, every event published |
| Extra: multi-agent negotiation before payment | claim → HCS order → one winner (`referee.ts`) |
| Extra: settling in an HTS token | FUSD `0.0.11332887` |

We use `x402ResourceServer` directly rather than the Fastify middleware, because that middleware runs the route
handler **before** settlement — unsafe for a paid job. Our order is fence → verify → record → settle → re-fence → run.

### Hedera — No Solidity Allowed

Zero `.sol` files. All ledger work via `@hiero-ledger/sdk`. Native services used: **HCS** (referee + audit log),
**HTS** (FUSD payments and refunds), **Mirror Node** (the resolver, the payment counter and `forkos audit`).

### World — World ID Agent Pass

Three protected actions, all validated in the backend (`services/api/src/world.ts`): **link an agent**,
**fire/replace an agent**, **spend above the autonomous cap**. The ID token is verified against the issuer's JWKS
with `iss`, `aud`, `exp` and `auth_time` freshness; step-ups pin the owner's `sub`; device codes are encrypted at
rest and never leave the backend. Denied, expired, cancelled, wrong-human and replayed-approval paths are in
[`docs/world-debrief.md`](docs/world-debrief.md).

**World AgentKit (human-backed agents) on the x402 path.** The provider's `402` carries the standard
`extensions.agentkit` challenge. The winning agent signs it (SIWE on World Chain) with its own key — the same key as
its Hedera account — and the API relays the `agentkit` header without ever holding agent keys. Before anything is
settled, the provider fence verifies the signature is fresh, single-use, issued by that provider and made by the
winning agent, then looks the wallet up in World **AgentBook**. `PROVIDER_AGENTKIT=off | verify | require`
(`require` serves only agents registered to a human). Code: `services/provider/src/agentkit.ts`,
`packages/agent-kit/src/agentkit.ts`.

## Run it

```bash
cd backend
pnpm install
cp .env.example .env            # fill OPERATOR_*, WORLD_*, OPENAI_API_KEY
pnpm keys:new                   # generates the wallet keys and secrets
pnpm db:up && pnpm db:migrate
pnpm bootstrap:hedera           # creates accounts, the FUSD token and the HCS topic

pnpm dev:facilitator            # :4020
pnpm dev:scribe-a               # :4031   (also -b :4032, -premium :4033)
pnpm dev:api                    # :4040

pnpm agent:link "Agent A"   # approve on your phone (World ID)
pnpm baseline                   # 3 independent agents -> 3 payments
pnpm agents 3                   # 3 ForkOS agents      -> 1 payment
```

`pnpm test` runs the suite; `pnpm typecheck` checks the whole workspace.

**Windows, one command** (after setup; Docker Desktop running) — starts Postgres + migrations, the facilitator, the
three providers and the API in the background, waits for every health check and warns if a baseline wallet is low:

```powershell
powershell -ExecutionPolicy Bypass -File backend\scripts\win\dev-up.ps1     # stop: backend\scripts\win\dev-down.ps1
```

Also in `backend\scripts\win\`: `use-meeting.ps1 -N <n>` (fresh demo meeting) and `topup-baseline.ps1`.
The full demo walkthrough is [`docs/demo-video.md`](docs/demo-video.md).

## Limitations (honest)

- **Testnet only.** Nothing here has handled real money.
- **Budget keys are custodial.** The API holds each human's budget-account key, encrypted with AES-256-GCM. Hedera
  Agent Accounts would remove this; we did not have time.
- **World identities are test identities.** Mocked proofs, as the Mumbai track specifies.
- **A refunded job is final** in this MVP — there is no automatic re-try with another provider.
- **The provider set is ours.** Third-party sellers work for *payment* today, but only a fenced provider gets the
  execution guarantee (S5); an unfenced seller can still be asked to run a job by a stale agent.
- **One Postgres for three services.** Fine for a hackathon, not a deployment topology.

## AI tools disclosure

This project was built with AI assistance (Claude). The planning documents written before the hack are committed
in [`docs/planning/`](docs/planning/) as ETHGlobal requires for spec-driven development; all project code was
written during the hackathon from those specs. AI assistance covered implementation from the spec, test authoring,
and documentation. The architecture, the death-clock mechanism, the safeguard model and every sponsor-integration
decision were authored by the team. Deviations found while building — including two real bugs in the spec, caught
by running against live testnet — are logged in
[`docs/planning/backend-deviations.md`](docs/planning/backend-deviations.md).

## Licence

MIT — see [`backend/LICENSE`](backend/LICENSE).
