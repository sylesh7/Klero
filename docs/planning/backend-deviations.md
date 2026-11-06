# Backend — deviations from the build doc

Every place the implementation differs from `ForkOS-Backend-Build-Doc.md`, and why. Kept current as
phases land so the doc stays the contract and the differences stay auditable.

---

## P1 — local Postgres port 5442 (not 5432)

Port 5432 on the dev machine is held by an unrelated container (`peregrine-postgres`). `docker-compose.yml`
maps `5442:5432` and `DATABASE_URL` points at 5442. The compose project is also named `forkos` so it never
collides with other stacks on the machine. Railway is unaffected (it injects its own `DATABASE_URL`).

## P1 — repo layout: everything under `backend/`

The doc's ICD-1 tree is rooted at the repo root. This repo keeps the backend monorepo in `backend/` and the
planning docs in `docs/`, so the frontend can live beside it without sharing a workspace. All paths in the
doc are relative to `backend/`. `apps/web` is not created (frontend is out of scope here).

## P1 — `@forkos/shared` + `@forkos/x402-hedera` linked into the root workspace

`scripts/` imports `@forkos/shared` (bootstrap, migrate, smoke tests). The doc only adds the third-party
libraries to the root. Both workspace packages are now root devDependencies so `scripts/*.ts` resolves them.

## P5 — Mirror Node rejects `sequencenumber=gt:0` (live-verified bug in the doc)

The doc builds `/api/v1/topics/{id}/messages?...&sequencenumber=gt:${afterSeq}` with `afterSeq = 0` as the
default. Live testnet returns **HTTP 400** `{"message":"Invalid parameter: sequencenumber"}` for `gt:0`,
because HCS sequence numbers start at 1. Probed against `testnet.mirrornode.hedera.com`:

| query | result |
|---|---|
| `sequencenumber=gt:0` | **400 Invalid parameter** |
| `sequencenumber=gt:1` | 200 |
| `sequencenumber=1` | 200 |
| filter omitted | 200 |

`afterSeq = 0` is what every cold start passes, so the HCS follower (P8) and the referee (P9) would both
throw on their first read — safeguard **S2** dead on boot.

**Fix:** the filter is omitted when `afterSeq < 1`. `expect` is clamped to `Math.max(1, afterSeq + 1)` so a
negative `afterSeq` does not misread the genuine first message as a gap.

## P5 — `topicMessages` split into three methods (bounded, resumable, gap-checked)

The doc's single `topicMessages` follows `links.next` in an unbounded loop. Against a topic with a long
backlog this walks for minutes (measured: 4+ min on a public test topic, still going when killed).

The design now rests on one fact: **a gap-free prefix in ascending order is never wrong, only incomplete.**
The referee rule is "first valid CLAIM by sequence number", so a caller holding every message up to its own
claim's seq can already decide the winner. Truncation cannot produce a wrong winner — only a *gap* could, so
gaps are detected and throw.

- `topicMessagesPage(topicId, afterSeq, maxPages = 50)` → one bounded slice, always a gap-free prefix,
  `{ messages, complete }`. `complete: false` means call again from the last seq returned. Page overlap
  (the `next` cursor is timestamp-based) is dropped rather than duplicated.
- `topicMessages(topicId, afterSeq)` → the whole tail, stitched slice by slice, so a mid-walk failure never
  discards what was already read. Throws if an incomplete slice returns no new messages (that would
  otherwise spin on an identical request forever).
- `topicMessage(topicId, seq)` → one message by sequence number; `null` on 404 so callers can retry.

Rejected alternative: throwing at a `maxPages` cap. It discards every message already read, so a cold start
on a long topic could never finish.

### Follow-ups this forces in P8 (apply when building `hcs.ts`)

- `readTopic` splits so decoding is reusable: `decodeAll(raw: MirrorTopicMessage[]): Decoded[]`.
- `waitForSeq` must use `mirror.topicMessage(topicId, seq)` — the doc has it calling
  `topicMessages(topic, 0)`, which is the third site hitting the `gt:0` bug.
- `TopicFollower.sync()` commits slice by slice via `topicMessagesPage`, advancing `lastSeq` as it goes, so
  a mid-sync Mirror failure resumes from `lastSeq` instead of restarting at 0.

## P4 — World issuer verified, client registration still pending

Both issuers' discovery documents were checked live. Both expose
`/api/v1/device_authorization` + `/api/v1/token`, support the `urn:ietf:params:oauth:grant-type:device_code`
grant and `client_secret_post`, and advertise scope `openid` — matching the doc's I.7 table.
`sandbox.auth.world.org` additionally offers `refresh_token`, `token-exchange` and `offline_access`.
Registering the confidential client needs a human (portal login), so `WORLD_CLIENT_ID` / `WORLD_CLIENT_SECRET`
are still placeholders.

## P6 — bootstrap persists each key the moment its account exists

The doc's `bootstrap-hedera.ts` holds all seven generated private keys in memory and writes
`deployments/testnet.json` + `.secrets/testnet-keys.json` once, at the very end. Any interruption after
the first `AccountCreateTransaction` leaves funded accounts on testnet whose keys no longer exist anywhere.
This is not hypothetical: an interrupted first run spent **171 HBAR** creating accounts that are now
unrecoverable.

`newAccount()` now appends `{label}:{accountId} -> privateKey` to `.secrets/testnet-keys.json` immediately
after each receipt, and re-reads an existing file on startup so a resumed run keeps earlier keys. The final
structured file is written as before, with the flat log kept alongside it for recovery.

## P8 — the follower must commit one HTTP page at a time

`TopicFollower.sync()` reads through `Mirror.topicMessagesPage`, which itself walks up to `maxPages` HTTP
pages and is **all-or-nothing**: a throw on its second page discards the first. Calling it with the default
bound made the "commit slice by slice, resume from lastSeq" property illusory — a unit test with a mirror
that fails mid-walk showed `latestSeq` falling back to 0.

`sync()` now passes `maxPages = 1`, so every HTTP page is a commit point. A mid-walk failure keeps
everything already read and the next `sync()` resumes with `sequencenumber=gt:<lastSeq>`.

## P10 — Arkiv smoke uses a faucet-funded wallet

The doc's `smoke-arkiv.ts` signs with `FORKOS_AGENT_KEY`, which has no tGLM: agent wallets are funded by the
API at link time (`AGENT_ARKIV_FUND_WEI`), not by the faucet. The smoke now defaults to
`PROVIDER_ARKIV_KEY` (faucet-funded) and honours `SMOKE_ARKIV_KEY` for an override.

Measured on Rabdi: `createEntity` took **8.3 s**, not the ~5 s the exit check suggests. Recorded in
`arkiv/friction.md` along with the consequence — agents publish the HCS `CLAIM` before the Arkiv claim, so
winner selection is never blocked on an Arkiv round trip. `eq('$key', key(...))` worked, so the
`getEntity` fallback the doc offers was not needed.

## P11 — migration runner silences Postgres notices

`create table if not exists schema_migrations` emits a `NOTICE: relation already exists, skipping` on every
re-run, which postgres.js prints as a raw object that looks exactly like a failure. `onnotice: () => {}`
silences it so a clean re-run prints only `skip 001_init.sql`.

Added `packages/shared/test/schema.test.ts`: the doc's exit check only lists table names, which proves
nothing about the constraints the exactly-once guarantee actually rests on. The new tests drive the live
database and assert that a duplicate `(job_key, round)`, a reused `tx_id`, a second `RUNNING`/`DONE` job for
one provider+job, a reused `payment_tx_id` and a replayed `fac_settlements` row are each rejected — while a
new round after VOID and a retry after FAILED are still allowed. Tests skip themselves when `DATABASE_URL`
is absent; `vitest.config.ts` now loads `.env` for them.

## P12/P13 — facilitator verified against the live package surface

Every import the doc names was checked against the installed packages before use:
`x402Facilitator` (with `onBeforeVerify`/`onBeforeSettle`/`onAfterSettle` hooks) from `@x402/core/facilitator`,
and `createHederaClient`, `createHederaPreflightTransfer`, `createHederaSignAndSubmitTransaction`,
`createHederaVerifyPayerSignature`, `toFacilitatorHederaSigner`, `extractTransactionFromPayload` from
`@x402/hedera`. All present at 2.30.0; no deviation needed.

Added `services/facilitator/test/replay.test.ts` beyond the doc's two guard tests. The replay table is the
S4 guarantee at our door, and the doc only exercises the window guard. The new tests drive `settleOnce`
against the live database and prove: a tx id already `SETTLING` or `SETTLED` is refused with
`forkos_replay_detected` without reaching the network; `attempts` is not bumped by a refused replay; an
expired intent is rejected *before* claiming a row, so a later legitimate attempt is not locked out; a
`FAILED` row may be retried with `attempts + 1`; and two concurrent claims for one tx id yield exactly one
winner. Two extra guard tests pin the 2 s pre-deadline cutoff and the duration cap boundary (120 accepted,
121 refused).

## P14/P15 — no deviation; extra property tests

The intent signer and resolver match the doc. `packages/x402-hedera` gained tests beyond the doc's four and
three: that the signed bytes really carry a 120 s validity and our chosen tx id (read back with
`Transaction.fromBytes`), that two intents built at the same instant collide on tx id so a retry cannot
double-spend, that the HBAR (`0.0.0`) fallback produces hbar legs and no token legs, that memo/amount/
feePayer/network are all validated, and that the resolver never returns VOID while Mirror knows the
transaction, treats `deadline + 45 s` as the exact boundary, and lets a Mirror outage propagate instead of
being mistaken for VOID.

One test fix: `Network` in `@x402/core` is the template type `` `${string}:${string}` ``, so a
"foreign network" test literal must be `eip155:84532`, not `base-sepolia`.

`scripts/smoke-pay.ts` reads the baseline payer key from either the structured secrets shape or the flat
incremental log written by the crash-safe bootstrap.

## P16–P22 — provider built straight to the fenced version

The doc stages the provider through stubs (P17 challenge with a pass-through fence, P18 paid path, P19 real
fence). The real fence landed in the same pass, so the P17 exit check "valid headers, no payment → 402" is
instead **409 `NOT_WINNER`** for a job with no claims. That is the P19 behaviour and the stronger one: a
losing or stale agent never even learns the price. Everything else matches.

`API_ARKIV_ADDRESS` and `PROVIDER_ALLOW_CHAOS` were added to `.env`/`.env.example` as ICD-2 says.

Verified live, all three instances: each publishes its `Service` entity to Arkiv and all three are
discoverable by capability with correct prices (scribe-b 0.04 < scribe-a 0.05 < scribe-premium 2.00 FUSD),
which is the Hedera "an agent that finds the endpoint" requirement. The 402 challenge carries
`extra.feePayer` from our own facilitator. Missing headers → 400, junk `PAYMENT-SIGNATURE` → 402
`invalid_payment_payload`, unknown payment → 404, stock baseline route → 402 from the unmodified
`@x402/fastify` middleware.

The job pipeline was exercised directly rather than left until a payment exists: a wrong `inputHash` raises
`InputHashMismatch`, the real sample audio downloads and hashes correctly, Whisper + the summary model
return a usable meeting summary in 7.6 s, and `outputHash` is deterministic over `{transcript, summary}`.
`hcsSeq` is still 0 because nothing publishes to our topic until the API links an agent (P25).

## P23 — API runs on port 4040 (not 4000)

`127.0.0.1:4000` is held by an unrelated container on the dev machine (`peregrine-cube`), which shadowed our
listener: requests to `localhost:4000` reached that app and returned an Express 404, even though Fastify
reported itself listening. `API_PORT`, `API_PUBLIC_URL` and `FORKOS_API_URL` are now **4040**.

**Frontend handoff note:** the API base URL is `http://localhost:4040`. Railway is unaffected (it injects
`PORT`, and the code prefers it).

`SAMPLE_AUDIO_URL` was added to `.env`/`.env.example` as P23 requires.

Verified: `/v1/health` returns the bootstrapped topic and asset, `/v1/events` holds open with the right SSE
headers and emits `: ping`, and removing `HUMAN_SALT` fails the boot with a readable
`Invalid environment: HUMAN_SALT: Required`.

## P24–P28 — World integration: everything but the phone tap is verified

The device flow, the backend validation and every guard are exercised against the **live** World issuer.
What cannot be automated is the human tapping approve in the World app, so the following are built and
waiting on that one step: owner sign-in completing, budget-account creation, agent linking, and revoke.

Verified without a phone:
- `POST /v1/owner/login/start` returns a real `user_code` and `verification_uri_complete` from
  `auth.world.org`, and the background worker polls it (status stays `PENDING`, not an error).
- The `device_code` is stored only as AES-256-GCM `iv.tag.cipher`, never in plaintext.
- `POST /v1/agents/link/start` rejects a `publicKeyHex` that does not derive the claimed `agentAddr`
  (400) and a malformed key (400), and starts a real World flow for a matching pair. This is the check
  that stops an agent claiming an address it does not hold the key for.
- Every owner-protected route (`/v1/me`, `/v1/agents`, `/v1/policy` GET and PUT, revoke start) returns 401
  without a session, and agent routes return 401 without an agent token.

`services/api/test/approvals.test.ts` adds two cases beyond the doc's two: a `REVOKE` approval digest can
never collide with an `OVERCAP` one, and the digest binds `fromEpoch`, so an approval to fire epoch 1
cannot be replayed to fire epoch 2.

## P29–P34 — no deviations; H1 (frontend handoff) is ready

`routes/chaos.ts` exists as an empty registrar so `index.ts` is the doc's final shape; the real panel lands
in P39.

Verified live:
- `/v1/config` returns the bootstrapped topic, operator, FUSD asset and all three providers.
- `/v1/directory` returns the three services **read from Arkiv**, not from config.
- `/v1/demo/job` hashes the real sample audio and is 403 without the demo key.
- `/v1/counter` is computed from **Mirror Node**: with the P15 smoke payment in range it reports
  `baseline: 1 payment` and names the exact transaction and recipient. That is the number the demo screen
  shows, and it never reads our database.
- The resolver and topic follower run clean (no `resolver tick failed`, no `[topic-follower]` errors).

### H1 handoff for the frontend

```
API base    http://localhost:4040        (NOT 4000 - see the P23 note)
SSE         GET /v1/events               (Last-Event-ID replay supported)
Contract    ICD-7 endpoints, ICD-8 events, ICD-11 states - all implemented as written
Login       POST /v1/owner/login/start -> poll GET /v1/owner/login/:attemptId -> token
Demo key    DEMO_KEY in backend/.env, sent out of band
CORS        WEB_ORIGIN defaults to http://localhost:5173
```

## P25 — `pnpm --filter @forkos/agents link` collides with pnpm's built-in `link`

The doc gives the linking command as `pnpm --filter @forkos/agents link "<label>"`. pnpm resolves `link` to its
**own** `pnpm link` command before looking at package scripts, so this fails with
`ERROR Unknown option: 'recursive'` and never runs `apps/agents/src/link.ts`.

Two fixes, both in place:
- `pnpm --filter @forkos/agents run link "<label>"` — `run` forces script resolution.
- A root alias `pnpm agent:link "<label>"`, which is what the README and MORNING.md now use.

Note the script takes the label as its first argument, so `pnpm agent:link --help` starts a real device flow
with the label `--help` rather than printing usage.

## P24 — device authorization sends `acr_values` (optional, `WORLD_ACR_VALUES`)

The doc's device start sends only `client_id`, `client_secret`, `scope=openid` (+ the pinned `sub` claim for
step-ups). On production `auth.world.org` that made the approval page offer **only** "Continue with a passkey",
so an Orb-verified user without a World IdP passkey could never finish: every attempt stayed
`authorization_pending` and expired.

World's step-up guide says passkeys are offered first *unless the first requested class is `orb-face` or
`selfie-face`*, and that the device endpoint accepts `acr_values`. So `startDeviceFlow` now adds
`acr_values=<WORLD_ACR_VALUES>` when that variable is set (`services/api/src/config.ts`, `world.ts`).

- Default is empty → requests are byte-for-byte what they were before.
- Set to `https://world.org/oidc/acr/orb-face` for the live demo. Approved tokens then carry
  `acr=…/orb-face` and `amr` including `face`. Linking (×3) and an over-cap approval completed with it live;
  revoke uses the same `startDeviceFlow` but was not exercised live.
- Requiring `orb-face` means only Orb-verified World IDs can approve. That is stricter than "Any account"; leave
  the variable empty if a non-Orb identity must be able to approve.

## P9 — referee: a REFUND that reaches consensus before SETTLED is held, not dropped (found live)

The referee accepted `REFUND` only after it had seen `SETTLED` for the same tx. Live on testnet the provider
refunded a chaos-failed job so fast that its `REFUND` (HCS seq 26) reached consensus **before** the operator's
`SETTLED` (seq 27). The refund was silently dropped: the job view said `PAID` forever, losing agents waited for
`DONE|REFUNDED` until they timed out, and `forkos audit` would not have checked the refund.

Now a trusted `REFUND` naming the current round's intent tx is held and applied when the matching `SETTLED`
arrives (reset when a round closes). A refund still never counts for a payment that did not settle. Tests:
early refund applied after SETTLED; early refund for a different tx ignored; early refund from an unknown
account ignored. After the fix the audit reports `A5 refund real` for both refunded jobs.

## P5 — Mirror client: per-request timeout + retries (found live)

`Mirror.get` was a bare `fetch` with no deadline. When a connection to the Mirror Node stalled, the call hung for
undici's 300 s `headersTimeout` and the winning agent crashed (`UND_ERR_HEADERS_TIMEOUT`) — twice in live runs,
both after the payment had already completed. Each request now has a 15 s deadline and up to 3 attempts with
backoff for network errors, timeouts and 5xx. **404 and other 4xx are never retried**: a 404 is an answer, and
the VOID proof rests on it. Options are `new Mirror(url, { timeoutMs, attempts, retryDelayMs })`.

## Arkiv removed — HCS carries the directory, claims and agent links

The project now uses two partners, Hedera and World. Everything Arkiv did is on the HCS topic (which was
already the source of truth for the referee and the agent links):

- **Service directory** → new HCS `SERVICE` message, submitted by each provider's own account on boot (skipped
  when the latest announcement is unchanged). `directoryFrom()` (`packages/shared/src/directory.ts`) lists an
  entry only when the message payer **and** its `payTo` are the provider account registered in
  `deployments/testnet.json`. This also fixes a spoofing gap: the Arkiv directory accepted entries from any wallet,
  so anyone could have listed a fake "scribe-a" with their own payout account.
- **Claims** → the HCS `CLAIM` alone. The `ak` field and the `X-ForkOS-Claim` header are gone; legacy CLAIMs that
  still carry `ak` decode unchanged (zod strips the field), so the audit over the existing topic still passes.
- **Agent links** → HCS `LINK`/`REVOKE` only. The API no longer writes AgentLink entities or funds agent wallets
  with tGLM. `agents.arkiv_key` dropped (migration 003).
- **Provider fence** → F1–F3 (round, status, HCS winner) + HCS link/epoch. The Arkiv claim (old F4) and Arkiv
  link (old F6) checks were duplicates of HCS state.
- Removed: `/v1/board` and the race page's Arkiv claim board (the HCS referee log shows every claim),
  `@arkiv-network/sdk`, `smoke:arkiv`, `backend/arkiv/`, all Arkiv env vars.

Verified live: providers announced on HCS (seq 71–73), `/v1/directory` reads from HCS, a 3-agent race paid once
(job `8c4e2a22…`, round 0), and `forkos audit` passed 9 jobs / 34 checks over the full topic history. 124 tests.

## World AgentKit — human-backed agents on the x402 path (new)

Not in the build doc. World's AgentKit extends x402 so a resource can tell human-backed agents from bots: the agent
signs a SIWE challenge and the server resolves its wallet in World **AgentBook** (World Chain). Integrated without
touching how payments settle:

- **Provider** (`services/provider/src/agentkit.ts`): the fenced `402` carries `extensions.agentkit`
  (`declareAgentkitExtension` + `enrichPaymentRequiredResponse`, network `eip155:480`, 5-min expiry, nonce tracked
  as issued). On the paid request the fence checks the relayed `agentkit` header — message bound to this endpoint,
  fresh, nonce issued here and unused, signature recovers the HCS winner — then `lookupHuman`. Modes via
  `PROVIDER_AGENTKIT`: `off` (default), `verify` (a sent header must be valid; records the human), `require`
  (unregistered or missing → `409 NOT_HUMAN_BACKED`). The extension is **not** registered on `x402ResourceServer`,
  so it never participates in payment verification. Result is recorded on `prov_jobs.agentkit_*` and returned in the
  job response.
- **Agent** (`packages/agent-kit/src/agentkit.ts`): before each `/v1/pay` the winner fetches the provider's challenge
  and signs it with its own key (same secp256k1 key as its Hedera account); a fresh proof per call because approvals
  can outlast the 5-minute challenge.
- **API**: `/v1/pay` accepts `agentkit`, stores it on the intent (`intents.agentkit_header`) and relays it on the paid
  request. The API never signs and holds no agent keys.
- Registration is a human step: `npx @worldcoin/agentkit-cli register <agent address>` + World App.
