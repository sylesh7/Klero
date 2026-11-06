# Arkiv — friction log

Written while building, not afterwards. Each entry is something that actually cost us time on Rabdi
(chain id 7794095) with `@arkiv-network/sdk@1.0.1`.

## Entity writes take ~8 s, not ~2 s

`createEntity` with a 30 s expiration returned after **8.3 s** on our first live write (measured, Rabdi
testnet). With a 2 s block time we had budgeted ~2–4 s. This matters for us specifically: our claim window
is 30 s, and an agent must post its Arkiv claim *and* its HCS `CLAIM` before the window closes. An 8 s write
eats a quarter of that budget before HCS is even touched.

What we changed: agents post the HCS `CLAIM` first and the Arkiv claim second. HCS consensus order is what
decides the winner, so the ordering that matters for correctness is never blocked on an Arkiv round trip.
Arkiv stays the human-readable claim board and the provider's fence input.

**What would help:** a documented expected latency range for `createEntity` on the testnet, so teams can
size their coordination windows up front instead of discovering it at 3 a.m.

## Expiry is exact and genuinely useful

A 30 s entity was gone at 40 s — `listClaims` returned 0 rows with no sweeping or cleanup on our side. This
is the feature that made us pick Arkiv for the claim board: a losing claim disappears on its own, so the
board is self-cleaning and a stale claim can never be mistaken for a live one. No TTL job, no cron.

Because block time is 2 s, lifetimes must be even — we added an `evenSeconds()` helper rather than
discovering a rounding surprise later.

## `$key` filtering works but is easy to miss

Fetching one entity by key needs the typed `key()` wrapper:
`where(eq('$key', key(entityKey)))`. Passing the raw hex string does not work. The README shows this only in
passing, inside a pagination example (`gt("$key", key(lastKey))`), so it reads like a paging detail rather
than the general way to filter on key. `getEntity(entityKey, Schema)` exists as the obvious alternative and
is easier to find.

**What would help:** a short "fetch one entity by key" snippet in the README next to the query builder docs.

## Typed values need unwrapping everywhere

Query results come back as `{ type, value }` per column rather than plain JS. Every read site needs
`String(e.col.value)` / `BigInt(e.col.value)`. We wrote two one-line helpers (`s()`, `n()`) and a `toRow`
mapper per schema. Not hard, but it is boilerplate in every single reader, and forgetting it fails at
runtime rather than at typecheck.

## The RPC URL is not in the docs we found

`https://rpc.rabdi.db-chain.testnet.arkiv.network` had to be read out of the SDK's compiled chain
definition. The hub pages cover access keys and the faucet but we could not find the raw RPC endpoint
documented, which we needed to check wallet balances directly before any SDK call.
