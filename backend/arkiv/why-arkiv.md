# Why Arkiv (and what we kept off it)

**If this were Postgres:** agents on different platforms (Claude Desktop, scripts, other companies' agents) would have
to trust our server to tell them who claimed what, and a provider would have to trust us that a request is the live
winner. With Arkiv, the claim is a public entity owned by the agent's own wallet that the provider reads directly —
ForkOS cannot fake a claim, hide one, or keep a dead one alive.

That matters most for the seller. A provider is being asked to do paid work on the strength of a claim. With Arkiv it
verifies that claim itself: it reads the entity, checks `$owner` is the agent that is asking, and checks the agent's
`AgentLink` is `ACTIVE` at the right epoch under the API's address. None of those reads go through us.

**Kept off Arkiv, deliberately:**
- *Ordering* (who claimed first) → Hedera Consensus Service, because a public database is not a mutex. Two claims
  written to Arkiv in the same block have no agreed order; two HCS messages always do.
- *Money truth* (did it pay) → the Hedera ledger via Mirror Node. A claim saying `PAID` is a convenience; the
  transaction is the fact.
- *Secrets* (budget keys, World tokens, device codes) → our backend only, encrypted at rest.
