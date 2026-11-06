# ForkOS — testnet proof

Raw output of `pnpm smoke:pay` against **Hedera testnet** through **our own facilitator**, plus the
Mirror Node reading of the settled transaction. Nothing here is mocked.

Deployment under test: FUSD `0.0.11332887` · HCS topic `0.0.11332888` · facilitator fee payer `0.0.11332879`

---

## The settled payment

| | |
|---|---|
| Transaction id | `0.0.11332879@1793930653.855000000` |
| Result | **SUCCESS** |
| Consensus timestamp | `1793930662.387795138` |
| HashScan | https://hashscan.io/testnet/transaction/1793930662.387795138 |
| Memo | `forkos:smoke1a1ae998414:r0` |
| Valid duration on-chain | **120 s** — the death clock, as the network recorded it |
| Amount | **0.001 FUSD** from baseline-1 `0.0.11332884` → scribe-a `0.0.11332881` |
| HBAR fee paid by | `0.0.11332879` (the facilitator), **not the paying agent** |

The transaction id was chosen by the client and **persisted before the bytes ever left the process**:

```
persisted BEFORE send: 0.0.11332879@1793930653.855000000 deadline 1793930774
verify: true
settle: true 0.0.11332879@1793930653.855000000
resolver: { state: 'PAID', consensusTimestamp: '1793930662.387795138' }
```

## It cannot be paid twice — four independent layers

**1. Our facilitator's replay table** rejects the identical payload before any network call:

```
2) replay the same payload through our facilitator
   settle: false forkos_replay_detected
```

**2. The Hedera network itself** rejects the same signed bytes, even submitted directly, bypassing every
facilitator we control:

```
3) resubmit the same bytes straight to the network
   network: DUPLICATE_TRANSACTION
```

**3. The death clock** kills an intent whose window has passed — refused by our facilitator *and* by the
network:

```
4) an intent whose clock already ran out (valid start 130 s ago)
   facilitator verify: forkos_intent_expired
   network:            TRANSACTION_EXPIRED
```

**4. VOID is a proof, not a guess.** An intent that was never sent, read back from Mirror Node after
`deadline + 45 s`:

```
5) an intent that is never sent → resolver after deadline + 45 s
   resolver: { state: 'VOID', provedAtS: 1793930671 }
```

Those bytes can never execute again: every node now rejects them as expired, and any copy submitted before
the deadline would already have reached consensus and be visible on Mirror Node. So the round can safely
reopen — there is no third state and no guessing.

## Balances after the run

```
scribe-a    0.001 FUSD   (received)
baseline-1  9.999 FUSD   (was 10.000)
```

Exactly one payment. Read from Mirror Node, not from our database.

---

## The ForkOS lane: three agents, one human, one payment (live, 2026-11-06)

Three agents linked to **one Orb-verified World ID** (`humanHash ae96247e…61f4`), each with its own Hedera
account created from its own key:

| Agent | Address | Hedera account | Linked with World code |
|---|---|---|---|
| Agent A | `0xa970793a…8390` | `0.0.11335838` | `B2UGW-YQE6Y` (acr `orb-face`) |
| Agent B | `0x4cb9d36e…ff63` | `0.0.11335860` | `UB9BC-NFEB4` (acr `orb-face`) |
| Agent C | `0x08cbf7aa…3644` | `0.0.11335879` | `UBSWH-V8ZJ8` (acr `orb-face`) |

`pnpm agents 3` on the sample meeting (`sha256:d192fc8c…915d0`). Each agent's LLM picked its own provider;
HCS consensus order picked the single winner:

```
[0x08cbf7] claimed round 1 via scribe-premium (HCS seq 12)
[0x4cb9d3] claimed round 1 via scribe-premium (HCS seq 10)
[0xa97079] claimed round 1 via scribe-b       (HCS seq 11)
[0x08cbf7] lost to seq 10 (later)
[0xa97079] lost to seq 10 (later)
[0x4cb9d3] WON (seq 10)
[0x4cb9d3] over cap → waiting for human approval (World ID)

Agent A  PAID_BY_OTHER
Agent B  PAID_BY_ME
Agent C  PAID_BY_OTHER
Mirror Node counter: {"payments":1,"txs":[{"txId":"0.0.11332879-1793950487-670000000",
  "cts":"1793950501.210407857","to":"0.0.11332883","amount":"2000000"}]}
```

| | |
|---|---|
| Transaction id | `0.0.11332879@1793950487.670000000` |
| Result | **SUCCESS** |
| HashScan | https://hashscan.io/testnet/transaction/1793950501.210407857 |
| Memo | `forkos:867700f303bbceba:r1` |
| Valid duration on-chain | **120 s** |
| Amount | **2.00 FUSD** → scribe-premium `0.0.11332883` |
| Human approval | over-cap (2.00 > 1.00 FUSD cap), World code `PUYPB-4DJDG`, approval `ap_hPKSg_jIcRKX` **USED** by intent `867700f303bbceba-r1` |

**Round 0 was abandoned safely.** In the first run the winner (Agent C) also chose the 2.00 FUSD provider; its
over-cap approval (`ap_QNntdDSchk1c`, code `ZNV8Y-2JQQJ`) was never approved, so **no intent was ever created**
and no money moved. The referee closed round 0 and opened round 1 on the next run.

Baseline lane on the same meeting, for contrast: **3 payments** (0.04 + 2.00 + 2.00 FUSD), counted from Mirror Node.

### Independent audit

Rebuilt from the public HCS topic and Mirror Node only, no server access:

```
pnpm forkos audit --topic 0.0.11332888 --operator 0.0.5899352 \
  --providers 0.0.11332881,0.0.11332882,0.0.11332883

✓ 867700f303bbceba  A1 one payment       1 SETTLED
✓ 867700f303bbceba  A2 settled is real   0.0.11332879@1793950487.670000000 SUCCESS memo=true
✓ 867700f303bbceba  A3 void proven       round 0 abandoned
✓ 867700f303bbceba  A4 winner paid       winner 0x4cb9d36e9c6711207db5c761e11b0e195a03ff63
1 jobs, 4 checks — ALL PASSED
```
