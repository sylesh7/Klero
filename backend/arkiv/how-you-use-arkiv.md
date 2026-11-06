# How ForkOS uses Arkiv

- **Filters match real questions.** Agents ask "which transcription services exist and what do they cost?"
  (`capability`, `price`); providers ask "is this the live claim for job J, round R, owned by agent A?" (`job`, `round`,
  `agent`, `$owner`); dashboards ask "show me every claim on this job" (`job`). Every indexed column exists because
  some caller filters on it — none are decorative.
- **Ownership is the security model.** A claim is owned by the agent that made it, so neither ForkOS nor another agent
  can forge or delete it. Service entries are owned by the provider. Agent links are owned by the API wallet, which only
  writes them after a World ID check — and the provider's fence only trusts `AgentLink` entities from that one address,
  so a link written by any other wallet is ignored.
- **Expiry is the death clock.** Losing claims vanish after 30 s. A winning claim lives while its payment can still
  settle; a payment that is proven void leaves no live claim. Services that stop refreshing drop out of the directory.
  No sweeper, no cron — we measured a 30 s claim returning zero rows at 40 s.
- **Every feature is visible:** the agents' service discovery, the dashboard's claim board and directory, and the
  provider's fence (it refuses jobs whose claim is not live on Arkiv) all read Arkiv.
