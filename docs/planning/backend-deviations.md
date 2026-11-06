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
