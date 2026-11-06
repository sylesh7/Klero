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
