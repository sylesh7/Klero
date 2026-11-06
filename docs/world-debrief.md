# World ID Agent Pass — integration debrief

- Issuer used: **https://auth.world.org** (production, with mocked proofs as the Mumbai track specifies)
- Client auth method: `client_secret_post` · Flow: Device Authorization Grant (RFC 8628)
- Accepted accounts: **Any account** (Orb-only or Selfie-Check would reject test identities)
- Requested class on every device authorization: `acr_values=https://world.org/oidc/acr/orb-face`
  (`WORLD_ACR_VALUES`, see "Friction" — without it the approval page only offered a passkey)
- Subject identifiers: default pairwise sector

## Approved path (live, 2026-11-06)

All three protected actions completed end to end with an Orb-verified World ID on production `auth.world.org`.
Every ID token was validated in the backend and recorded:

```
kind     status    user_code     acr                                   amr
LINK     APPROVED  B2UGW-YQE6Y   https://world.org/oidc/acr/orb-face   ["pop","face","user","mfa"]
LINK     APPROVED  UB9BC-NFEB4   https://world.org/oidc/acr/orb-face   ["pop","face","user"]
LINK     APPROVED  UBSWH-V8ZJ8   https://world.org/oidc/acr/orb-face   ["pop","face","user"]
OVERCAP  APPROVED  PUYPB-4DJDG   https://world.org/oidc/acr/orb-face   ["pop","face","user"]
```

- **Link (×3):** one human, three agents (`0.0.11335838`, `0.0.11335860`, `0.0.11335879`), each with
  `LINK` + `APPROVAL` on HCS. Same `sub` → same `humanHash` → one budget and one dedupe scope.
- **Over-cap payment:** approval `ap_hPKSg_jIcRKX` was bound to the digest of the exact 2.00 FUSD payment and
  marked `USED` by the one intent it authorized. Result: one payment for three agents (see `docs/proof.md`).

## What we built with it

Three protected actions, each validated entirely in the backend:

1. **Link an agent to a human.** This is the one that makes ForkOS work at all. Because the same World identity
   resolves to the same `sub`, an agent linked from Claude Desktop and an agent linked from a script land in the
   same budget and the same dedupe scope. Cross-platform exactly-once is a direct consequence of Agent Pass.
2. **Fire or replace an agent.** A step-up with the owner's `sub` pinned, bound to a digest of the exact action
   (`{kind, human, agent, fromEpoch}`). On approval the agent's epoch bumps, its tokens die, and providers refuse
   it immediately via the fence.
3. **Spend above the autonomous cap.** The approval digest covers job, round, provider, payTo, amount and asset,
   and is consumed in the same database transaction that writes the payment intent.

4. **Human-backed agents on the payment path (World AgentKit).** The provider's x402 `402` response carries the
   standard `extensions.agentkit` challenge (World Chain, single-use nonce, 5-minute lifetime). The winning agent
   signs it with its own key and the API relays the header. The provider fence, before any money moves, checks the
   message (target, freshness, a nonce it issued and never saw), recovers the signer, requires it to be the HCS
   winner, and resolves the wallet's anonymous human in World **AgentBook**. `PROVIDER_AGENTKIT=require` refuses any
   agent whose wallet is not registered to a human (`409 NOT_HUMAN_BACKED`). AgentKit is deliberately not
   registered as an x402 hook, so it can never change how a Hedera payment is verified or settled.
   Live: a 3-agent race carried the proof agent → API → provider (header 748 bytes, signer = winner); 8 tests cover
   replayed, foreign-challenge, wrong-wallet, malformed, unregistered and `require`-mode cases.

Validation performed on every ID token (`services/api/src/world.ts`): RS256 signature against the issuer's JWKS,
`iss`, `aud`, `exp`, `auth_time` present and fresh within `WORLD_FRESH_SECONDS`, and `auth_time` not earlier than
the attempt started. Device codes are stored AES-256-GCM encrypted and never leave the backend.

## Denied / expired / cancelled paths

| # | Path | Expected | Status |
|---|---|---|---|
| D1 | Cancelled / account not accepted | attempt `DENIED (access_denied)`, nothing changes | **OBSERVED** — see below |
| D2 | Left to expire | attempt `EXPIRED`, nothing changes | **OBSERVED** — see below |
| D3 | Identity not accepted by the app's policy | `DENIED (access_denied)` | **OBSERVED** — see below |
| D4 | Approval replayed onto a different payment | digest mismatch -> a new approval is required; the first is never consumed | **verified by test** (`services/api/test/approvals.test.ts`) |
| D5 | Approval used twice | `409 APPROVAL_MISMATCH (already used)` | **verified** (consumed under `for update` in one transaction) |

D4 and D5 are covered by automated tests. D1, D2 and D3 were observed live.

### Observed expired path (live, 2026-11-06)

Several `LINK` codes were opened but never completed (the approval page asked for a passkey the user did not
have) and ran past World's 20-minute device-code lifetime:

```
user_code     status   reason
9FAQ4-YF5RN   EXPIRED  device code expired
PQ29Z-VQ89E   EXPIRED  device code expired
6UH8M-QD5N5   EXPIRED  device code expired
G6LPJ-CKMSB   EXPIRED  expired_token
```

None of them created an agent, a Hedera account or an HCS message: exactly three agents exist, one per approved
code. Separately, an **over-cap approval that was never approved** (`ap_QNntdDSchk1c`, round 0) left the payer
waiting; no intent was created, no money moved, and the referee later opened round 1.

### Observed denied path (live, 2026-11-06)

Two `LINK` attempts were approved on a phone whose World account did not meet the application's accepted-accounts
policy. World returned `access_denied` at the token endpoint. Our worker recorded:

```
user_code     status   reason
6X443-Q23Y2   DENIED   access_denied
L7J74-WWY2Y   DENIED   access_denied
```

The protected action did **not** occur, and nothing partial was left behind:

```
humans 0 | agents 0 | agent_tokens 0 | owner_sessions 0
operator balance unchanged (510.86 HBAR) -- no Hedera account was created or funded
```

This is the important property: agent linking creates a Hedera account and publishes to
HCS, and **none of it happens** unless World returns a validated approval first. The side effects are strictly
downstream of the `APPROVED` branch in `startWorldWorker`.

## Friction we hit

- **The device flow needs a confidential client, and the auth method cannot be changed after registration.**
  Choosing `client_secret_post` vs `client_secret_basic` is a one-way door made at minute one, before you have
  written any code. We checked `token_endpoint_auth_methods_supported` from the discovery document first; a
  newcomer would not know to.
- **"Default accepted accounts" is a silent failure mode.** Leaving it on Orb means every test identity ends in
  `access_denied`, which looks identical to a user cancelling. We only knew to pick "Any account" because the
  prize text mentioned mocked proofs.
- **The device approval page offered only "Continue with a passkey".** After the World ID app reported
  "You have successfully shared your proofs anonymously", the browser page still showed only a passkey button and
  "First time here? Create an account first". A user with an Orb-verified World ID but no World IdP passkey
  could not finish, and the attempt silently stayed `authorization_pending` until it expired. The fix was in the
  docs' step-up guide, not the device-flow guide: passkeys are offered first *unless the first requested class is
  `orb-face` or `selfie-face`*, and the device endpoint accepts `acr_values`. Sending
  `acr_values=https://world.org/oidc/acr/orb-face` changed the page to "Requires: Orb with face check" and the
  approval completed. Note the user still needed a World IdP account with a passkey; the end-user account and
  passkey setup are not described anywhere in the docs.
- **`account_not_eligible` looks like an end-user error but is not.** Seen while trying the sandbox, it refers to
  the *developer portal* Google account not being allowed to register a client in that environment, not to the
  World ID trying to log in.
- **No `nonce` in device-flow ID tokens** (correct per the spec, since there is no browser redirect) means
  freshness has to come from `auth_time`. That is easy to get wrong — a naive integration would accept a token
  minted for an earlier attempt. We pin `auth_time >= attempt.started_at - 5 s` as well as a max age.

## Missing capability or documentation

- There is no way to ask "is this `sub` the same person as that `sub`" across two of our own flows without
  storing the `sub` itself. We hash it immediately (`humanHash = sha256(iss | sub | salt)`), but the raw value
  still has to exist in our database to detect a returning user. A stable, app-scoped pseudonymous id intended
  for storage would let integrators keep nothing reversible.
- The docs describe the device flow well for a human signing into a TV. They do not describe the case we
  actually have: **an autonomous agent requesting authority from a human who is elsewhere.** A short page on
  agent-delegation patterns — how to bind an approval to an action, how to expire delegated authority — would
  have saved us the design work in safeguards S1 and S6.

## The one improvement with the greatest impact

**Let a client request an approval that is bound to a payload, and echo that payload back in the ID token.**

Today we bind an approval to an action by computing a digest ourselves, storing it, and re-checking it when the
approval is consumed. That works, but the binding lives in *our* database — a judge has to trust our code that
the human approved *this* payment and not some other one. If the authorization request could carry an opaque
`action_digest` and the resulting ID token returned it as a claim, the binding would be signed by World, and
"the human approved exactly this payment of 2 FUSD to this provider" would be independently verifiable by anyone
holding the token. That single change would turn human-in-the-loop agent spending from a trust-us control into a
provable one.
