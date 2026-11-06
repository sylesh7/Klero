# Klero — 3-minute demo video

**One idea to land:** three agents try to buy the same thing → without Klero they pay **3 times**, with Klero
they pay **once** — and judges can try to break it and verify it themselves.

ETHGlobal rules: 2–4 minutes, at least 720p, **your own voice**, no speed-up, no music-only stretches.
**Cuts are allowed** — cut out waiting (Mirror Node, the phone), never speed it up.

> Naming: the product is **Klero**. Some commands and on-chain memos still say `forkos` (`pnpm forkos audit`,
> memo `forkos:<job>:r0`) — that is the protocol prefix; don't rename it on camera.

---

## Before you hit record (≈15 min)

### 1. Everything running

Every backend terminal is **PowerShell in `backend\`** and starts with:

```powershell
$env:npm_config_script_shell = "C:\Program Files\Git\bin\bash.exe"
```

| Check | URL / command |
|---|---|
| Postgres | `docker compose up -d db` |
| Facilitator | `pnpm dev:facilitator` → http://localhost:4020/health |
| Scribe A / B / Premium | `pnpm dev:scribe-a` / `-b` / `-premium` (10 s apart) → :4031 / :4032 / :4033 |
| API | `pnpm dev:api` → http://localhost:4040/v1/health |
| Frontend | `cd ..\frontend; npm run dev` → http://localhost:3000 |
| Directory has 3 services | http://localhost:4040/v1/directory |

### ⚠️ Only one backend on the shared topic

Every copy of the backend that holds the operator key watches the **same HCS topic**. If a teammate's API is
running at the same time, its resolver sees your job's winner waiting for your World approval, finds no
approval in **its** database, and **VOIDs the round after 60 s** — the agents start a new round with a new
approval, again and again. Before recording, make sure **no one else is running `pnpm dev:api`** (or that
everyone has pulled the resolver fix that only closes rounds for humans registered in its own database).

### 2. Two fresh meetings (a paid meeting skips straight to "already paid")

```powershell
cd services\provider\public
foreach ($n in 5,6) { ffmpeg -loglevel error -y -i sample-meeting.mp3 -b:a 128k -metadata title="video-$n" "video-$n.mp3" }
cd ..\..\..

function Use-Meeting($n) {
  (Get-Content .env) -replace '^SAMPLE_AUDIO_URL=.*', "SAMPLE_AUDIO_URL=http://localhost:4031/video-$n.mp3" | Set-Content .env
  Get-NetTCPConnection -LocalPort 4040 -State Listen -EA SilentlyContinue | % { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"; Stop-Process -Id $p.ProcessId,$p.ParentProcessId -Force -EA SilentlyContinue }
  "API stopped -> run 'pnpm dev:api' again"
}

Use-Meeting 5      # then restart pnpm dev:api in its terminal
```

### 3. Screen set-up

- [ ] Signed in at http://localhost:3000/login (World ID) — **/dashboard shows Agents A, B, C, all ACTIVE**
- [ ] Browser tab 1: http://localhost:3000 (landing page)
- [ ] Browser tab 2: http://localhost:3000/dashboard
- [ ] Browser tab 3: http://localhost:3000/race → click **Load demo job** → status `OPEN`
- [ ] Browser tab 4: https://hashscan.io/testnet/topic/0.0.11332888
- [ ] Terminal: backend folder, script-shell line done, **font size ≥ 18**, dark theme
- [ ] Phone unlocked, World App open (needed if a winner picks the 2.00 FUSD provider) — mirror it to the
      screen or film it in a corner
- [ ] Notifications off, 1920×1080 recording

---

## The script (3:00)

Narration is ~420 words at a calm pace. **Bold** = say it with emphasis.

### 0:00 – 0:15 · Hook

| Screen | Do | Say |
|---|---|---|
| Tab 1, landing page hero ("Fork. Claim. Pay. Once.") | Slow scroll to the "Payments settled: 1" widget | "AI agents now pay for things on their own. But when two of your agents buy the same thing — or a payment times out halfway — **did you pay once, twice, or not at all?** Nobody can answer that today. Klero can." |

### 0:15 – 0:45 · How agents pay today (3 payments)

| Screen | Do | Say |
|---|---|---|
| Tab 3, /race (job locked, `OPEN`) | Nothing to click: **Load demo job** already started the counters at "now". | "Here's one meeting recording and three agents. First, the way agents pay today: each has its own wallet and the standard x402 client." |
| Terminal (in `backend\`) | `pnpm baseline` | — *(cut the wait, ~30 s)* |
| Terminal output, then /race **Baseline lane** | Point at the three tx ids, then the lane showing **3** (it refreshes every few seconds) | "Three agents, three LLM decisions, **three payments for the same meeting.** Standard x402 stops a retry of one request — it can't stop three agents buying one job." |

> ⚠️ **Do not click New race after `pnpm baseline`.** New race resets the counting window to *now*, so the
> baseline payments that already happened drop out and the lane goes back to 0. New race is only for
> re-arming the counters **before** you run baseline (for example after a failed take).
>
> The baseline never touches HCS — **"Claims on HCS" stays at (0) until you run `pnpm agents 3`.** That is
> expected, not a bug.

### 0:45 – 1:35 · Same agents with Klero (1 payment)

| Screen | Do | Say |
|---|---|---|
| Tab 2, /dashboard | Hover the three linked agents | "Now the same three agents with Klero. Each one linked to me once with **World ID** — so Klero knows they belong to the same human, with one budget." |
| Tab 3, /race | — | "Same meeting." |
| Terminal | `pnpm agents 3` | — |
| /race: **Arkiv board** → **HCS timeline** | Point at three claims, then the winner | "Every agent posts a claim — on **Arkiv**, owned by its own wallet, and on a **Hedera Consensus Service** topic. Consensus order is the referee: **first valid claim wins**, and everyone computes the same winner from public data." |
| *(usually happens: 2 of the 3 agent personas pick the 2.00 FUSD provider)* approval sheet in the browser + link in the terminal → phone | Open the link printed in the terminal (or scan the sheet's QR), check the code, **Continue with a passkey → approve** within 5 min. You can close the sheet to watch the race — that keeps the request open. **Never press "Deny this payment"** unless you mean it | "This agent picked the premium service — over my 1 FUSD cap. So it needs **me**, with a fresh World ID approval bound to this exact payment." *(cut the wait)* |
| /race **Klero lane** shows **1**; terminal table | Point at `PAID_BY_ME` / `PAID_BY_OTHER` ×2 | "One agent paid. The other two got the result **without paying.** And that counter is read from **Hedera Mirror Node** — not from our database." |
| Click **Proof →** (next to the death clock) → /proof page → HashScan | Show `SUCCESS`, valid duration **120 s** | "Here it is on HashScan — settled in our own HTS token through our own x402 facilitator." |

### 1:35 – 2:25 · "Try to make us pay twice"

> **Off camera (cut):** `Use-Meeting 6`, restart `pnpm dev:api`, on /race click **Load demo job**.

| Screen | Do | Say |
|---|---|---|
| /race **chaos panel** | Click **Kill next payer** | "Now let's break it. I'll kill the payer's connection **400 milliseconds after it sends the money.**" |
| Terminal | `pnpm agents 3` | — |
| /race: status `PAYMENT_UNKNOWN` + **death clock** | Point at the clock counting down | "The payer doesn't know if it paid. Most systems would retry — and pay twice. We **never re-sign.** Every payment has a transaction id we chose in advance, and it **dies 120 seconds** after it starts." |
| /race: → `PAID`, counter still **1** | — *(cut the wait)* | "The resolver asks Mirror Node. Found → paid. Not found after the clock → **provably void, forever.** There's no third state. Still **one** payment." |
| Chaos panel | Click **Replay** (within 2 min) → shows `forkos_replay_detected` | "And replaying the exact same signed payment? **Refused** — by our facilitator, and by Hedera itself." |

### 2:25 – 2:45 · Don't trust us — verify

| Screen | Do | Say |
|---|---|---|
| Terminal | `pnpm forkos audit --topic 0.0.11332888 --operator 0.0.5899352 --providers 0.0.11332881,0.0.11332882,0.0.11332883` | "You don't have to trust our server. Anyone can rebuild every job from the public topic and re-check every payment on the ledger." |
| Output: `ALL PASSED` | Highlight it | "**All passed.**" |

### 2:45 – 3:00 · Close

| Screen | Do | Say |
|---|---|---|
| Tab 1, landing page (or a title card) | — | "**Hedera** for the referee, the death clock and settlement. **World ID** so every agent belongs to a real human. **Arkiv** for the directory and the claims. Klero ships as an MCP server, an agent kit and a CLI. **Agents fork. Money doesn't.**" |

---

## If something goes wrong while recording

| Symptom | What to do |
|---|---|
| `pnpm` command hangs at start | That terminal is missing the `npm_config_script_shell` line |
| `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` | You are in the repo root. `cd backend` first — every `pnpm` command runs from `backend\` |
| Baseline ran but its lane shows 0 | You clicked **New race** after the baseline (window reset). Click **New race**, run `pnpm baseline` again, don't click it after |
| "Claims on HCS (0)" after `pnpm baseline` | Expected — only `pnpm agents 3` posts claims to HCS |
| /race shows `DONE` instantly, nobody pays | That meeting was already paid → `Use-Meeting <new n>` (make another file) |
| Over-cap approval takes long | Keep talking, then cut. The link lives 5 min — approve within that |
| Rounds keep restarting ("claimed round 1, 2, 3…") and new approval links keep appearing | Another backend is running against the same topic and VOIDing your rounds after 60 s. Ask teammates to stop `pnpm dev:api` (or pull the fix), then use a fresh meeting |
| You approved but the race didn't continue | You approved an **older** link — the round was already closed. Always approve the **latest** link the terminal printed, and match the code |
| Payment stays "unknown" | That's the feature — it resolves to PAID or VOID within ~3 min. Cut the wait |
| Replay says `forkos_intent_expired` | You waited > 2 min. Still refused — say "refused, expired", or redo on a fresh meeting |
| Lanes don't show baseline = 3 | You ran baseline before the job was loaded (or long before). Click **New race** (visible once a job is locked), run `pnpm baseline` again — and don't click New race afterwards |
| Can't find **New race** | No job is locked yet ("none locked"). Click **Load demo job** first; New race appears next to it |
| **Load demo job** shows `DONE` instantly | The API is still on an already-paid meeting → `Use-Meeting <n>`, restart `pnpm dev:api`, load again |
| A terminal prints a 5-minute timeout | A dropped connection to Mirror Node; the payment usually finished — check /race and cut |

## After recording

- [ ] Length 2:00–4:00, 720p or higher, your voice throughout, no speed-up
- [ ] Every waiting moment is cut, not sped up
- [ ] One HashScan link visible on screen and readable
- [ ] Note the settled tx ids from this take in `docs/proof.md` if they're new
