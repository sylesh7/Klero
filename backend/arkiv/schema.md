# ForkOS on Arkiv — schema

Network: **Rabdi testnet**, chain id `7794095`. Defined in `packages/shared/src/arkiv.ts`.

| Entity (schema tag) | Owner (who can edit) | Indexed fields we query | Other fields | Expires |
|---|---|---|---|---|
| `forkos.service.v1` | each provider's wallet | providerId, capability, network, asset, price | name, endpoint, payTo | 24 h, refreshed every 6 h (dead services disappear) |
| `forkos.agentlink.v1` | ForkOS API wallet `0xade1e2f78619532a4b1fd7c4710e84d4b46f74e9` | human, agent, status, epoch | acct, label | 30 days, re-extended on every change |
| `forkos.claim.v1` | **the agent's own wallet** | job, round, human, agent, status | epoch, svc, price, seq, tx | 30 s if it loses; winner extends to 10 min, then 24 h once PAID (receipt) |

## Writer wallets

| Role | Address |
|---|---|
| API (writes `AgentLink`) | `0xAde1e2f78619532a4b1fd7C4710e84d4B46f74E9` |
| Providers (write `Service`) | `0x09FaDF2A6f36381dc7998962F38A81bCE456Ca89` |
| Agents (write their own `Claim`) | one wallet per linked agent, funded with tGLM by the API at link time |

## A query you can run

Every service currently offering transcription, which is exactly what an agent runs to find an endpoint:

```ts
import { arkivPublic, listServices } from '@forkos/shared';

const pub = arkivPublic(process.env.ARKIV_ACCESS_KEY!);
console.log(await listServices(pub, 'transcribe+summarize.v1'));
```

Live output from this deployment:

```
scribe-b          40000  http://localhost:4032/v1/jobs   (0.04 FUSD)
scribe-a          50000  http://localhost:4031/v1/jobs   (0.05 FUSD)
scribe-premium  2000000  http://localhost:4033/v1/jobs   (2.00 FUSD)
```

Claims for one job (the dashboard's claim board and the provider's fence both run this):

```ts
select().from(forkos.claim.v1).where(eq("job", "<jobKey>"))
```

See `listClaims` and `getClaim` in `packages/shared/src/arkiv.ts`.
