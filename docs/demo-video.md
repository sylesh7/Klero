# Klero — recording the 3-minute demo video

**The one idea:** three agents try to buy the same meeting transcript. Without Klero they pay **3 times**.
With Klero they pay **once** — even when we kill the payer mid-payment — and anyone can verify it.

**ETHGlobal rules:** 2–4 minutes · at least 720p · your own voice · **no speed-up** · no music-only stretches.
Cuts are fine: record in scenes and cut out every wait. Never speed anything up.

> **On-screen naming.** The product is **Klero**. The right-hand lane on the race page is still labelled
> **"ForkOS"**, and some commands say `forkos` (`pnpm forkos audit`, memo `forkos:<job>:r0`) — that's the
> protocol prefix. On camera call it "the Klero lane"; don't comment on the label.

---

## Part 1 — Set-up (once, ~20 min)

### 1.1 You must be the only backend running ⚠️

Every copy of the backend that holds the operator key watches the same public HCS topic. If a teammate's API
is running an older version, it **closes your rounds 60 s after the claims** — your World approval then lands on
a dead round and the agents start over. **Before recording, message the team: "stop `pnpm dev:api` until I'm
done"** (everyone on `main` after PR #3 is safe, but it's simplest if only you run it).

### 1.2 Start the stack

Open **PowerShell** in `D:\Projects\Klero-1\backend`. In **every** backend terminal, run this first or `pnpm`
hangs:

```powershell
$env:npm_config_script_shell = "C:\Program Files\Git\bin\bash.exe"
```

| Terminal | Command | Ready when |
|---|---|---|
| 1 | `docker compose up -d db` (then reuse this terminal for commands) | prints `Started` / `Running` |
| 2 | `pnpm dev:facilitator` | http://localhost:4020/health → `ok` |
| 3 | `pnpm dev:scribe-a` | http://localhost:4031/health |
| 4 | `pnpm dev:scribe-b` (start ~10 s after scribe-a) | http://localhost:4032/health |
| 5 | `pnpm dev:scribe-premium` (~10 s later) | http://localhost:4033/health |
| 6 | `pnpm dev:api` | http://localhost:4040/v1/health |
| 7 | `cd ..\frontend; npm run dev` | http://localhost:3000 opens |

Check http://localhost:4040/v1/directory lists **3 services**. Terminal 1 is your **command terminal** from
now on (backend folder, script-shell line done).

### 1.3 Paste the helper (command terminal)

Every scene needs a meeting that has **never been paid** — a paid meeting skips straight to "already paid".
`Use-Meeting <n>` makes meeting *n* (if needed), points the API at it and restarts the API in a new window.

```powershell
function Use-Meeting($n) {
  $f = "services\provider\public\video-$n.mp3"
  if (-not (Test-Path $f)) { ffmpeg -loglevel error -y -i services\provider\public\sample-meeting.mp3 -b:a 128k -metadata title="video-$n" $f }
  $t = (Get-Content .env -Raw) -replace '(?m)^SAMPLE_AUDIO_URL=.*$', "SAMPLE_AUDIO_URL=http://localhost:4031/video-$n.mp3"
  [IO.File]::WriteAllText("$PWD\.env", $t)
  Get-NetTCPConnection -LocalPort 4040 -State Listen -EA SilentlyContinue | % { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"; Stop-Process -Id $p.ProcessId,$p.ParentProcessId -Force -EA SilentlyContinue }
  Start-Process powershell -ArgumentList '-NoExit','-Command',"`$env:npm_config_script_shell='C:\Program Files\Git\bin\bash.exe'; cd '$PWD'; pnpm dev:api"
  "video-$n ready. Wait ~20 s (all services reload), check http://localhost:4040/v1/health, then click Load demo job."
}
```

Meetings **video-5** and earlier are already paid. Start at **7** and count up for every scene and retake.

### 1.4 Screen, browser, phone

- [ ] Signed in at http://localhost:3000/login with World ID; **/dashboard shows Agent A, B, C — ACTIVE**
- [ ] Browser tabs, in this order: **1** http://localhost:3000 · **2** /dashboard · **3** /race ·
      **4** https://hashscan.io/testnet/topic/0.0.11332888
- [ ] Browser zoom so the two lanes and the job steps fit on one screen (≈ 80–90 %)
- [ ] Terminal: font ≥ 18, dark theme, window placed **next to** the browser (both visible)
- [ ] Phone unlocked, World App open, ready for "Continue with a passkey"
- [ ] Notifications off, recording at 1920×1080

### 1.5 Dry run (do this once, don't record)

Run Scene A once start to finish. It confirms World approvals work, the lanes update, and you know where to
click. Then move to fresh meetings for the real takes.

---

## Part 2 — The script

Record **three scenes separately** and cut them together. Narration is ~420 words at a calm pace.
**Bold** = stress it.

### Scene A (0:00 – 1:35) · hook → baseline → Klero

**Before you press record**

1. Command terminal: `Use-Meeting 7` → wait ~20 s → http://localhost:4040/v1/health is `ok`.
2. Tab 3 (/race): click **Load demo job** → job id appears, status **`OPEN`**, both lanes **0**,
   "Claims on HCS (0)".
3. Switch to Tab 1. Press record.

| Time | Screen | Do | You should see | Say |
|---|---|---|---|---|
| 0:00 | Tab 1, landing page | Slow scroll to the "Payments settled: 1" widget | — | "AI agents now pay for things on their own. But when two of your agents buy the same thing — or a payment times out halfway — **did you pay once, twice, or not at all?** Nobody can answer that today. Klero can." |
| 0:15 | Tab 3, /race | — | job `OPEN`, lanes 0 / 0 | "One meeting recording, three agents. First, how agents pay today: each has its own wallet and the standard x402 client." |
| 0:22 | Terminal | `pnpm baseline` | 3 "LLM chose …" lines, then a table with 3 tx ids *(~30 s — cut)* | — |
| 0:28 | /race left lane | Point at the lane | **Baseline lane → 3** | "Three agents, three decisions, **three payments for the same meeting.** x402 stops a retry of one request — it can't stop three agents buying one job." |
| 0:45 | Tab 2, /dashboard | Point at the three agents | 3 agents, one budget | "Now the same three agents with Klero. Each was linked to me once with **World ID** — so Klero knows they belong to one human, with one budget." |
| 0:55 | Terminal | `pnpm agents 3` | "claimed round 0 … (HCS seq N)" ×3, then "WON" / "lost" | — |
| 1:00 | /race: job steps + referee log (HCS) | Point at the claims, then the winner | "Claims on HCS (3)", 3 CLAIM rows in the referee log, one winner | "Every agent posts a claim on a **Hedera Consensus Service** topic, from its own Hedera account. Consensus order is the referee: **first valid claim wins**, and everyone computes the same winner from public data." |

**Then one of two things happens — the winner is random:**

| If… | Screen / Do | Say |
|---|---|---|
| **A. An approval sheet pops up** (the winner chose Scribe Premium, 2.00 FUSD — happens most takes) | Sheet shows QR + code. On the phone: open the **latest** link from the terminal (or scan the QR), check the code matches, **Continue with a passkey → approve**. You may close the sheet to watch the race — that does **not** deny it. *(Cut the wait.)* | "This agent picked the premium service — over my 1 FUSD cap. So it needs **me**: a fresh World ID approval, bound to this exact payment." |
| **B. No sheet** (the cheapest agent won, 0.04 FUSD) | Nothing to do | "The winner picked the cheapest service — under my cap, so no human needed." |

| Time | Screen | Do | You should see | Say |
|---|---|---|---|---|
| 1:15 | /race right lane + terminal table | Point at the lane, then `PAID_BY_ME` / `PAID_BY_OTHER` ×2 | **Klero lane → 1**, job **`DONE`** | "One agent paid. The other two got the result **without paying.** And both counters come from **Hedera Mirror Node** — not our database." |
| 1:25 | Click **Proof →** (next to the death clock) → **HashScan → open** | Show the tx | `SUCCESS`, valid duration 120 s | "Settled in our own HTS token, through our own x402 facilitator. Here it is on HashScan." |

Stop recording.

### Scene B (1:35 – 2:25) · "try to make us pay twice"

**Before you press record**

1. Command terminal: `Use-Meeting 8` → wait ~20 s → health `ok`.
2. Tab 3: click **Load demo job** → status `OPEN`. Scroll so the **chaos panel** and the **job steps** are both
   visible. Press record.

| Time | Screen | Do | You should see | Say |
|---|---|---|---|---|
| 1:35 | Chaos panel | Click **Kill next payer** | "Armed: kill next payer" | "Now let's break it. I'll kill the payer's connection **400 milliseconds after it sends the money.**" |
| 1:40 | Terminal | `pnpm agents 3` | claims, a winner; terminal says **`PAYMENT_UNKNOWN → waiting for the resolver`** *(if an approval sheet appears, approve it — cut)* | — |
| 1:50 | /race job steps + death clock | Point at the clock | status `PAYMENT_UNKNOWN`, clock counting down from 120 s | "The payer doesn't know if it paid. Most systems retry — and pay twice. We **never re-sign.** Every payment has a transaction id we chose in advance, and it **dies 120 seconds** after it starts." |
| 2:05 | /race | — *(cut the wait)* | status **`DONE`**, Klero lane **1** | "The resolver asks Mirror Node. Found → paid. Not found after the clock → **provably void, forever.** No third state. Still **one** payment." |
| 2:15 | Chaos panel | Click **Replay** — **within 2 minutes** of the payment | result `forkos_replay_detected` | "And replaying the exact same signed payment? **Refused.**" |

Stop recording.

### Scene C (2:25 – 3:00) · verify, then close

| Time | Screen | Do | You should see | Say |
|---|---|---|---|---|
| 2:25 | Terminal | `pnpm forkos audit --topic 0.0.11332888 --operator 0.0.5899352 --providers 0.0.11332881,0.0.11332882,0.0.11332883` | rows of ✓, ends with **`ALL PASSED`** *(~20 s — cut)* | "You don't have to trust our server. Anyone can rebuild every job from the public topic and re-check every payment on the ledger." |
| 2:40 | Terminal | Highlight `ALL PASSED` | — | "**All passed.**" |
| 2:45 | Tab 1 (landing) or a title card | — | — | "**Hedera** for the referee, the death clock and settlement. **World ID** so every agent belongs to a real human. A spoof-proof service directory on HCS, too. Klero ships as an MCP server, an agent kit and a CLI. **Agents fork. Money doesn't.**" |

---

## Part 3 — Retakes

A scene can't be repeated on the same meeting (it's paid now). For a retake: `Use-Meeting <next number>`,
wait ~20 s, **Load demo job**, record again. Meetings are cheap — use as many as you need.

---

## Part 4 — If something goes wrong

| Symptom | Cause → fix |
|---|---|
| A `pnpm` command hangs at the start | Terminal is missing the `npm_config_script_shell` line |
| `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` | You're in the repo root → `cd backend` |
| **Load demo job** shows `DONE` instantly | That meeting is already paid → `Use-Meeting <new n>` |
| Can't find **New race** | It only appears once a job is locked. You rarely need it: Load demo job already starts the counters at "now" |
| Baseline ran but its lane shows 0 | **New race** was clicked *after* the baseline (window reset). Reload the job, run `pnpm baseline` again, don't click New race afterwards |
| "Claims on HCS (0)" after `pnpm baseline` | Expected — only `pnpm agents 3` posts claims |
| Terminal says "claimed round 1, 2, 3…" and new approval links keep appearing | Rounds are being closed: another teammate's old API is running → ask them to stop it, then `Use-Meeting <new n>` |
| You approved but nothing continued | You approved an **older** link (dead round). Always use the **latest** link and match the code |
| Approval sheet closed by accident | Fine — the request is still open; approve from the terminal link |
| Payment stays `PAYMENT_UNKNOWN` | That's the feature — resolves to PAID or VOID within ~3 min. Cut the wait |
| Replay says `forkos_intent_expired` | More than 2 min passed. Still refused — say "refused", or retake Scene B |
| API window won't start: port 4040 in use | Run `Use-Meeting <same n>` again — it kills the old API first |
| A terminal prints a 5-minute timeout error | A dropped connection to Mirror Node (now retried automatically); check /race — the payment usually finished |
| Browser: "Cannot reach the Klero API" | API window not up yet (wait 20 s), or the frontend isn't on port 3000 |

---

## Part 5 — After recording

- [ ] Final length 2:00–4:00, 720p+, your voice throughout, **cuts only, no speed-up**
- [ ] One HashScan transaction is on screen and readable
- [ ] Baseline **3** and Klero **1** are both clearly visible at some point
- [ ] Copy the settled tx ids from your takes into `docs/proof.md`
- [ ] Tell the team they can restart their APIs
