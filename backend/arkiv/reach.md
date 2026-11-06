# Reach

Anyone running AI agents that pay over x402 hits this the first time a request times out, or the first time two
agents act on the same task. That is not a rare edge: parallel sub-agents are the default in every agent framework
shipping today, and a dropped connection is a daily event.

ForkOS ships in the three shapes an agent developer actually consumes:

- **`@forkos/x402-hedera`** — an npm wrapper for the official x402 client. Payment intents with a death clock, and a
  resolver that turns an unknown outcome into PAID or provably VOID. Useful on its own, with no other part of ForkOS.
- **`forkos-mcp`** — an MCP server, so a Claude Desktop or Cursor agent gets a safe `pay` tool without holding a
  payment key.
- **`forkos` CLI** — `forkos audit` lets anyone re-derive every job from the public HCS topic and re-check each
  payment against Mirror Node, with no access to our servers.

The Arkiv schemas are the integration surface. `forkos.service.v1` is a directory any seller can publish into, and
`forkos.claim.v1` is a coordination primitive any agent framework can read and write. We will keep both stable after
Mumbai so other frameworks can join the same dedupe scope rather than build a parallel one.
