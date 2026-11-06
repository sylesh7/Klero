# ForkOS — demo runbook (4 min live, 2–4 min video)

## Before you go on

- [ ] Owner logged in on the dashboard; **3 agents linked** (make one of them Claude Desktop via MCP)
- [ ] A **fresh** audio URL ready (any second mp3) so the job is new — a repeated job is already PAID and will
      skip straight to the dedupe answer
- [ ] Phone unlocked with the World app open
- [ ] HashScan tab open on topic `0.0.11332888`
- [ ] `DEMO_KEY` set in the dashboard
- [ ] All five services healthy: facilitator :4020, scribe-a/b/premium :4031–4033, API :4040

## Script

| Time | Say | Do | Screen |
|---|---|---|---|
| 0:00–0:25 | "Your agent sent a payment and the Wi-Fi died. Did it pay? Nobody can answer that today." | — | title |
| 0:25–1:05 | "Here's how agents pay today. Three agents, each with a wallet, same meeting." | **Run baseline** | **3 payments**, 3 HashScan links |
| 1:05–1:50 | "Same three agents with ForkOS. One is Claude Desktop, two are scripts. They've never met — World ID knows they're the same human." | **Run ForkOS** (+ ask Claude Desktop to transcribe the same URL) | claims on HCS, HCS order picks one winner, **counter = 1**, read from Mirror Node |
| 1:50–2:40 | "Now try to make us pay twice." *Hand the laptop over.* | **Kill payer** on a new job | `PAYMENT_UNKNOWN`, death clock counts down, → PAID or VOID → counter still **1** |
| 2:40–3:10 | "Replay the old payment." / "Revive a fired agent." | **Replay**; revoke an agent on the phone, then **Revive** | `forkos_replay_detected`; provider `409 STALE_AUTHORITY` |
| 3:10–3:35 | "Expensive service? A human approves that exact payment." | buy from scribe-premium | World approval on phone → paid; the same approval replayed on another job is refused |
| 3:35–4:00 | "Don't trust us — verify." | run `forkos audit` | all ✓ · "npm package, MCP server, CLI — any agent gets exactly-once payments." |

## The one number that matters

The counter is read from **Mirror Node**, not our database. Say that out loud when it shows 1. If a judge
doubts it, run `forkos audit` — it re-derives every job from the public topic and re-checks each payment
against the ledger, with no access to our servers.

## If something breaks on stage

| Symptom | Say this, do this |
|---|---|
| A payment hangs | "That's the unknown state — watch." It resolves to PAID or VOID on its own. This is the feature, not a failure. |
| Provider 409 | Read the code out: `NOT_WINNER` or `STALE_AUTHORITY`. The fence refusing is the product working. |
| World approval is slow | Keep talking over it; the device code lives 20 min. |
| Mirror lag | The counter catches up in a few seconds. Switch to the HashScan tab meanwhile. |
| Everything is down | Fall back to `docs/proof.md` — the raw testnet output, with HashScan links. |

## Video

2–4 minutes, ≥ 720p, your own voice, no speed-up, no music-only stretches. Same script. Record the baseline
lane and the ForkOS lane back to back — the contrast between **3** and **1** is the whole pitch.
