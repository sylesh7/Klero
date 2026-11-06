# Morning handoff

Backend is **code-complete**: phases P1–P41 and P43–P45 built, verified and pushed across 11 commits.
108 tests passing, `pnpm typecheck` clean, zero `.sol` files, no secrets tracked.

## Start everything (one command)

```bash
cd backend
pnpm dev:up      # postgres + migrations + facilitator + 3 providers + api
pnpm dev:down    # stop them again
```

Logs land in `backend/.logs/`. The API is on **:4040** (not 4000 — another container on your machine owns 4000).

## What is already proven on testnet

| | |
|---|---|
| A real x402 payment settled in FUSD through our own facilitator | [`0.0.11332879@1793930653.855000000`](https://hashscan.io/testnet/transaction/1793930662.387795138) |
| Replaying it | refused by our facilitator (`forkos_replay_detected`) **and** by Hedera (`DUPLICATE_TRANSACTION`) |
| An expired intent | refused by both (`forkos_intent_expired`, `TRANSACTION_EXPIRED`) |
| An intent never sent | resolver proved it **VOID** |
| The baseline lane | **3 independent agents paid 3 times for one meeting** — the number ForkOS reduces to 1 |
| Provider job pipeline | hash gate → Whisper → summary → deterministic output hash, 7.6 s on real audio |
| Directory | 3 services announced on HCS by their registered provider accounts (spoofed entries ignored) |

Full raw output: [`docs/proof.md`](proof.md).

## The only thing left that needs you: 3 phone taps

Everything around World ID is built and tested up to the human tap. Do this and the last lane closes:

```bash
cd backend
pnpm dev:up

# 1. link three agents — each prints a World link, approve on your phone
pnpm agent:link "Agent A"
pnpm agent:link "Agent B"
pnpm agent:link "Agent C"

# 2. the money shot: three agents race one job, exactly one pays
pnpm agents 3

# 3. anyone can verify it, with no access to our servers
pnpm forkos audit --topic 0.0.11332888 --operator 0.0.5899352 \
  --providers 0.0.11332881,0.0.11332882,0.0.11332883
```

Expected: one `PAID_BY_ME`, two `PAID_BY_OTHER`, counter `forkos.payments: 1`, audit all ✓.
Run `pnpm agents 3` a second time with the same audio → all three `PAID_BY_OTHER`, counter still 1.

While you are at it, fill the D1–D3 rows in [`world-debrief.md`](world-debrief.md): cancel one approval,
let one expire, and try approving a revoke from a different identity. Those are the World prize's
"unsuccessful path" evidence. D4 and D5 are already covered by automated tests.

## Still outstanding

| Phase | What | Blocker |
|---|---|---|
| **P42** | Railway deploy (6 services) + e2e on the deployed stack | your Railway login. Config and start commands are in the build doc; `portFrom` already prefers Railway's `PORT`. |
| **P45** | Record the 2–4 min video | you, on camera. Script is in [`demo-runbook.md`](demo-runbook.md). |
| **P46** | `git tag v1.0.0` | after deploy, not before |

## Two real bugs found in the build doc

Both caught by running against live testnet rather than trusting the spec, both logged in
[`planning/backend-deviations.md`](planning/backend-deviations.md):

1. **Mirror Node rejects `sequencenumber=gt:0`** with HTTP 400. That is exactly what a cold start passes, so
   the HCS follower and the referee would both have thrown on their first read — safeguard S2 dead on boot.
2. **`topicMessagesPage` was all-or-nothing**, which made the follower's "resume from lastSeq" property
   illusory; a unit test with a mid-walk failure showed progress falling back to 0.

There is also a third, smaller one worth knowing: the doc's bootstrap script held all seven generated private
keys in memory and wrote them only at the very end, so an interruption orphaned funded accounts. That cost 171
testnet HBAR before it was fixed to persist each key as its account is created.

## Deviations from the doc you should know about

- API on **4040**, Postgres on **5442** — both because other containers on your machine own the default ports.
- Everything lives under `backend/`; planning docs moved to `docs/planning/` for the ETHGlobal disclosure.
- The provider was built straight to the fenced version, so a job with no claims returns `409 NOT_WINNER`
  rather than a 402 price. That is the stronger behaviour: a losing agent never learns the price.
