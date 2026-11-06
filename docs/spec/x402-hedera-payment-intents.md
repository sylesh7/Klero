# Payment intents for x402 `exact` on Hedera (death clock)

Status: draft, implemented by ForkOS (`@forkos/x402-hedera`). Compatible with the existing `exact` Hedera scheme —
facilitators and resource servers need no changes.

## Problem
An x402 client that loses the response to a paid request cannot tell whether it paid. Retrying risks paying twice;
not retrying risks never receiving the resource. Request-level idempotency keys do not prove that a lost payment
will not settle later.

## Mechanism (client-side, spec-compatible)
1. The client sets `transactionId = (extra.feePayer, validStart)` itself, with `validStart = now - 5 s`,
   `transactionValidDuration = 120 s`, and an application memo.
2. The client persists `{txId, validStart, deadline = validStart + 120 s, signed bytes}` **before** sending.
3. Retries resend the **identical bytes** while `now < deadline - 10 s`. The client never re-signs while the outcome
   is unknown.
4. Resolution: query the Mirror Node for `txId`.
   - result `SUCCESS` → PAID
   - other result → FAILED (consensus reached, value did not move)
   - not found and `now > deadline + 45 s` → VOID: the bytes are expired network-wide and can never execute.

## Why it is sound on Hedera
- Duplicate transaction ids are rejected (`DUPLICATE_TRANSACTION`) for the receipt period.
- Expired transactions are rejected (`TRANSACTION_EXPIRED`) when `validStart + validDuration` < consensus time.
- Consensus and Mirror Node availability are seconds, so the margin is small and the proof is cheap.

## Facilitator recommendations
- Keep a persistent replay table keyed by `txId` (reject while SETTLING or after SETTLED).
- Reject payloads with `transactionValidDuration > 120` or that are already expired.

## Reference implementation
`createIntentSigner`, `buildIntentPayment`, `resolveIntent` in `packages/x402-hedera`. Testnet evidence in `docs/proof.md`.

## Testnet evidence

All four properties were observed on Hedera testnet (full output in `docs/proof.md`):

| Property | Observed |
|---|---|
| Client-chosen id settles | `0.0.11332879@1793930653.855000000` → SUCCESS, on-chain `validDuration` 120 s |
| Facilitator refuses a replay | `forkos_replay_detected` before any network call |
| The network refuses the same bytes | `DUPLICATE_TRANSACTION` on direct resubmission |
| Expiry is enforced both sides | `forkos_intent_expired` (facilitator) and `TRANSACTION_EXPIRED` (network) |
| VOID is provable | resolver returned `{ state: 'VOID' }` for an intent that was never sent |
