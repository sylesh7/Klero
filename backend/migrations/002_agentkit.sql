-- World AgentKit (human-backed agents).
-- intents.agentkit_header: the agent's signed `agentkit` header, relayed by the payer on the paid request.
-- prov_jobs.agentkit_*: what the provider proved about the paying agent (AgentBook anonymous human id + wallet).
alter table intents   add column if not exists agentkit_header  text;
alter table prov_jobs add column if not exists agentkit_human   text;
alter table prov_jobs add column if not exists agentkit_address text;
