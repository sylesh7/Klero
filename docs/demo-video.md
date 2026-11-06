# Klero — recording the 3-minute demo video

**The one idea:** three AI agents try to buy the same meeting transcript. Without Klero they pay **3 times**.
With Klero they pay **once** — even when we kill the payer mid-payment — every paying agent is proven to belong to
a real human, and anyone can verify the whole thing.

**Sponsors on screen:** **Hedera** (HCS referee + directory, HTS token, x402 settlement, Mirror Node) and
**World** (World ID linking + approvals, World AgentKit human-backed agents).

**ETHGlobal rules:** 2–4 minutes · at least 720p · your own voice · **no speed-up** · no music-only stretches.
Record in scenes and **cut** the waits. Never speed anything up.

> **Repository:** https://github.com/sylesh7/Klero (branch `main`). Local folder: `D:\Projects\Klero-1`.
> **Naming:** the product is **Klero**. The race page's right lane is still labelled **"ForkOS"** and some commands
> say `forkos` (`pnpm forkos audit`, memo `forkos:<job>:r0`) — that is the protocol prefix. Say "the Klero lane".

---

## Part 1 — Set-up (once, ~15 min)

### 1.1 You must be the only backend running ⚠️

Every copy of the backend holding the operator key watches the same public HCS topic. An old teammate copy can
close your rounds while you are approving. **Before recording, tell the team to stop their backend.**

### 1.2 Start everything — one command each

Start **Docker Desktop** first. Then, in PowerShell:

```powershell
# backend: Postgres + migrations, facilitator, 3 providers, API (hidden, logs in backend\.logs\)
powershell -ExecutionPolicy Bypass -File D:\Projects\Klero-1\backend\scripts\win\dev-up.ps1

# frontend (separate window)
cd D:\Projects\Klero-1\frontend; npm run dev
```

`dev-up.ps1` ends with **"Klero backend is up."**, the HCS directory (3 services), `AgentKit mode require` and the
current demo meeting. If it prints a **WARNING** about a baseline wallet, top it up (1.4). Stop everything with
`scripts\win\dev-down.ps1`.

### 1.3 World AgentKit check (already done for Agents A, B, C)

`backend\.env` has `PROVIDER_AGENTKIT=require`: providers only serve agents whose wallet is registered to a human in
**World AgentBook**. All three agents are registered to the same World ID. If you ever link a new agent, register it:

```powershell
npx @worldcoin/agentkit-cli register <agent address>
```

### 1.4 Commands you'll use (keep a terminal in `D:\Projects\Klero-1\backend`)

| Need | Command |
|---|---|
| A fresh, never-paid meeting (restarts only the API, ~15 s) | `powershell -ExecutionPolicy Bypass -File scripts\win\use-meeting.ps1 -N 21` |
| Top up the baseline wallets (each baseline run uses up to ~4 FUSD) | `powershell -ExecutionPolicy Bypass -File scripts\win\topup-baseline.ps1` |
| Run the agents / baseline / audit | first `$env:npm_config_script_shell = "C:\Program Files\Git\bin\bash.exe"`, then `pnpm baseline`, `pnpm agents 3`, `pnpm forkos audit …` |

Meetings up to **20 are used** — start at **21** and count up for every scene and retake.

### 1.5 Screen, browser, phone

- [ ] Signed in at http://localhost:3000/login with World ID — **/dashboard shows Agent A, B, C ACTIVE**
- [ ] Browser tabs: **1** http://localhost:3000 · **2** /dashboard · **3** /race · **4** https://hashscan.io/testnet/topic/0.0.11332888
- [ ] Browser zoom ~80–90 % so both lanes and the job steps fit
- [ ] Terminal next to the browser (both visible), font ≥ 18
- [ ] Phone unlocked, World App open (over-cap approvals: "Continue with a passkey" → approve)
- [ ] Notifications off, 1920×1080

### 1.6 Dry run (don't record)

Run Scene A once end to end. It confirms World approvals, AgentKit and the lanes all work. Then use fresh meetings.

---

## Part 2 — The script (3:00)

Three scenes recorded separately and cut together. **Bold** = stress it.

### Scene A (0:00 – 1:40) · hook → baseline → Klero

**Before you press record**
1. `scripts\win\use-meeting.ps1 -N 21` → "Ready".
2. Tab 3 (/race): click **Load demo job** → job id, **round 0**, **`OPEN`**, pill **"counting since HH:MM:SS"**, both lanes **0**.
3. Switch to Tab 1. Press record.

| Time | Screen | Do | You should see | Say |
|---|---|---|---|---|
| 0:00 | Tab 1, landing page | Slow scroll to the "Payments settled: 1" widget | — | "AI agents now pay for things on their own. But when two of your agents buy the same thing — or a payment times out halfway — **did you pay once, twice, or not at all?** Nobody can answer that today. Klero can." |
| 0:15 | Tab 3, /race | — | job `OPEN`, lanes 0 / 0 | "One meeting recording, three agents. First, how agents pay today: each has its own wallet and the standard x402 client." |
| 0:22 | Terminal | `pnpm baseline` | 3 "LLM chose …" lines, a table with 3 tx ids *(~30 s — cut)* | — |
| 0:28 | /race left lane | Point at it | **Baseline lane → 3** (refreshes every few seconds) | "Three agents, three decisions, **three payments for the same meeting.** x402 stops a retry of one request — it can't stop three agents buying one job." |
| 0:45 | Tab 2, /dashboard | Point at the three agents | 3 agents, one budget | "Now the same three agents with Klero. Each was linked to me once with **World ID** — so Klero knows they belong to one human, with one budget." |
| 0:55 | Terminal | `pnpm agents 3` | "claimed round 0 … (HCS seq N)" ×3, then "WON" / "lost" | — |
| 1:00 | /race: job steps + referee log | Point at the claims, then the winner | "Claims on HCS (3)", 3 CLAIM rows, one winner | "Every agent posts a claim on a **Hedera Consensus Service** topic, from its own Hedera account. Consensus order is the referee: **first valid claim wins**, and everyone computes the same winner from public data." |

**Then one of two things happens — the winner is random:**

| If… | Do | Say |
|---|---|---|
| **A. An approval sheet pops up** (winner chose Scribe Premium, 2.00 FUSD — most takes) | Open the **latest** link from the terminal (or scan the sheet's QR), check the code, **Continue with a passkey → approve** within 5 min. Closing the sheet keeps the request open — **never press "Deny this payment"**. *(Cut the wait.)* | "This agent picked the premium service — over my 1 FUSD cap. So it needs **me**: a fresh World ID approval, bound to this exact payment." |
| **B. No sheet** (cheapest agent won, 0.04 FUSD) | Nothing | "The winner picked the cheapest service — under my cap, so no human needed." |

| Time | Screen | Do | You should see | Say |
|---|---|---|---|---|
| 1:15 | /race right lane + terminal table | Point at the lane, then `PAID_BY_ME` / `PAID_BY_OTHER` ×2 | **Klero lane → 1**, job **`DONE`** | "One agent paid. The other two got the result **without paying.** Both counters come from **Hedera Mirror Node** — not our database." |
| 1:25 | Click **Proof →** (next to the death clock) | Point at the **World AgentKit** row | **"✓ human-backed · AgentBook 0x69ad…"** | "And before taking a cent, the provider checked **World AgentKit**: this agent's wallet is registered to a real human in World's AgentBook. Bots don't get served." |
| 1:33 | **HashScan → open** | Show the tx | `SUCCESS`, valid duration 120 s | "Settled in our own HTS token, through our own x402 facilitator." |

Stop recording.

### Scene B (1:40 – 2:25) · "try to make us pay twice"

**Before you press record**
1. `scripts\win\use-meeting.ps1 -N 22` → "Ready".
2. Tab 3: click **Load demo job** → `OPEN`. Scroll so the **chaos panel** and the **job steps** are both visible.

| Time | Screen | Do | You should see | Say |
|---|---|---|---|---|
| 1:40 | Chaos panel | Click **Kill next payer** | "Armed: kill next payer" | "Now let's break it. I'll kill the payer's connection **400 milliseconds after it sends the money.**" |
| 1:45 | Terminal | `pnpm agents 3` | a winner, then **`PAYMENT_UNKNOWN → waiting for the resolver`** *(approve if a sheet appears — cut)* | — |
| 1:52 | /race: status + **death clock** | Point at the clock | `PAYMENT_UNKNOWN`, clock counting down from 120 s | "The payer doesn't know if it paid. Most systems retry — and pay twice. We **never re-sign.** Every payment has a transaction id we chose in advance, and it **dies 120 seconds** after it starts." |
| 2:05 | /race | — *(cut the wait)* | **`DONE`**, Klero lane **1** | "The resolver asks Mirror Node. Found → paid. Not found after the clock → **provably void, forever.** Still **one** payment." |
| 2:15 | Chaos panel | Click **Replay** — **within 2 minutes** | `forkos_replay_detected` | "And replaying the exact same signed payment? **Refused.**" |

Stop recording.

### Scene C (2:25 – 3:00) · verify, then close

| Time | Screen | Do | You should see | Say |
|---|---|---|---|---|
| 2:25 | Terminal | `pnpm forkos audit --topic 0.0.11332888 --operator 0.0.5899352 --providers 0.0.11332881,0.0.11332882,0.0.11332883` | rows of ✓, ending **`ALL PASSED`** *(~20 s — cut)* | "You don't have to trust our server. Anyone can rebuild every job from the public topic and re-check every payment on the ledger." |
| 2:40 | Terminal | Highlight `ALL PASSED` | — | "**All passed.**" |
| 2:45 | Tab 1 (landing) or a title card | — | — | "**Hedera** for the referee, the death clock and settlement. **World** so every agent belongs to a real human — World ID to link and approve, AgentKit so only human-backed agents get served. Klero ships as an MCP server, an agent kit and a CLI. **Agents fork. Money doesn't.**" |

---

## Part 3 — Retakes

A paid meeting can't be reused. For a retake: `scripts\win\use-meeting.ps1 -N <next>` → **Load demo job** → record.
After 3–4 baseline runs, run `scripts\win\topup-baseline.ps1`.

---

## Part 4 — If something goes wrong

| Symptom | Cause → fix |
|---|---|
| `dev-up.ps1`: "Docker is not running" | Start Docker Desktop, run it again |
| `dev-up.ps1`: a service shows **FAIL** | Read `backend\.logs\<service>.log`; run `dev-up.ps1` again (it stops leftovers first) |
| A `pnpm` command hangs at the start | That terminal is missing `$env:npm_config_script_shell = "C:\Program Files\Git\bin\bash.exe"` |
| `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` | You're in the repo root → `cd backend` |
| **Load demo job** shows `DONE` instantly | That meeting is already paid → `use-meeting.ps1 -N <new>` |
| **New race** — what does it do? | Restarts the counting window at "now" (the pill and a toast confirm it). Not needed after **Load demo job** |
| Baseline ran but its lane shows 0 | New race was clicked *after* the baseline. Click New race, run `pnpm baseline` again |
| Baseline shows **402** for some agents | A baseline wallet is out of FUSD → `topup-baseline.ps1`, run again |
| "Claims on HCS (0)" after `pnpm baseline` | Expected — only `pnpm agents 3` posts claims |
| Agents fail with **`NOT_HUMAN_BACKED`** | That agent's wallet isn't in World AgentBook → `npx @worldcoin/agentkit-cli register <address>` (or set `PROVIDER_AGENTKIT=verify` and rerun `dev-up.ps1`) |
| "claimed round 1, 2, 3…" and new approval links keep appearing | Another backend is closing your rounds → ask teammates to stop theirs, then a fresh meeting |
| You approved but nothing continued | You approved an **older** link — always use the **latest** one and match the code |
| Payment stays `PAYMENT_UNKNOWN` | That's the feature — resolves to PAID or VOID within ~3 min. Cut |
| Replay says `forkos_intent_expired` | More than 2 min passed. Still refused — say "refused", or retake Scene B |
| Browser: "Cannot reach the Klero API" | Backend not up (`dev-up.ps1`), or the frontend isn't on port 3000 |
| Mirror Node returns `502` in the logs | Hedera's public Mirror Node is having a moment; Klero retries automatically. Wait, or cut |

---

## Part 5 — After recording

- [ ] Length 2:00–4:00, 720p+, your voice throughout, **cuts only, no speed-up**
- [ ] One HashScan transaction readable on screen
- [ ] Baseline **3** and Klero **1** both clearly visible at some point
- [ ] The **World AgentKit ✓ human-backed** row visible on the proof page
- [ ] Copy the settled tx ids from your takes into `docs/proof.md`
- [ ] Tell the team they can restart their backends
