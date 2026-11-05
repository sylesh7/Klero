# ForkOS — Frontend Build Doc (`apps/web`)

> **Agents fork. Money doesn't.** This doc builds the ForkOS web app on the ScanPay Next.js template. It keeps the template's styles, fonts, colours, boxes and components, and changes the content.
> One owner, one doc. Work through it phase by phase (F0 → F14). Every API call here matches the backend doc's **ICD-7** (HTTP), **ICD-8** (SSE), **ICD-11** (states) and **ICD-12** (errors) exactly. If something disagrees, the backend doc wins. Fix this doc and tell the backend owner.

---

## 0. Ground rules

- **Template:** `austinjeremiah/Scanpay` → `frontend/` (Next.js **16.4.0**, React 19.3, TanStack Query 5, sonner, lucide-react, zod 4, qrcode).
- **Next 16:** read `node_modules/next/dist/docs/` before using anything that isn't in this doc. Every page here is a **client component** (`'use client'`) and reads params with `useParams()`/`useSearchParams()`. That sidesteps the async `params` prop changes.
- **Keep from the template:**
  - `app/app.css` (tokens `--pale --pale-2 --neon --ink --dark --mute --line`, ok/bad/warn/info tones, Inter Tight and Stack Sans Notch, sharp corners, uppercase micro-labels)
  - `components/app/ui.tsx` (Spinner, Skeleton, Pill, Notice, Sheet, StateBlock, QrView, CopyButton, Countdown, StepList, TechDetails)
  - The providers pattern (QueryClient, sonner Toaster)
  - The `ApiError` + `call()` client
  - The `useSse` EventSource pattern
  - The `(site)` Webflow marketing layout
- **Delete from the template:**
  - Mera/passkey/session/vault/keys/sign/chain/originPay
  - viem/bip32/bip39/qr-scanner
  - The `@scanpay/shared` alias
  - All ScanPay `(app)` routes
- **Secrets:**
  - The frontend never sees the World client secret, any private key, World `sub`, device codes or agent tokens (`fat_…`).
  - The only bearer token in the browser is the owner session token `fos_…`, kept in `localStorage`.
  - `NEXT_PUBLIC_DEMO_KEY` is public by nature. It only unlocks the chaos/demo routes on a testnet demo, so never reuse a real secret there.
- **No backend changes are needed.** The only backend setting is `WEB_ORIGIN`, which must include the frontend origin (see F0).

### What the user sees (screens)

| Route | Auth | Purpose | Sponsors on screen |
|---|---|---|---|
| `/` | none | Marketing landing (template `(site)`, copy changed) | all three named |
| `/login` | none | World ID Agent Pass device flow → owner session | **World** |
| `/dashboard` | owner | Budget balance, policy, linked agents, revoke, pairing code | **World**, **Hedera** (HTS balance) |
| `/race` | owner | **The demo:** baseline vs ForkOS lanes, live Mirror counter, Arkiv claim board, HCS timeline, death clock, chaos panel | **Hedera**, **Arkiv**, **World** |
| `/directory` | none | Service directory read from **Arkiv** | **Arkiv** |
| `/proof/[intentId]` | owner | One payment's audit: intent → HCS → Mirror → HashScan | **Hedera** |
| global sheet | owner | Live **approval** sheet (World QR) for revoke / over-cap pay | **World** |

### Contract cheat-sheet (copied from backend ICD-7/8 — do not invent fields)

- Base: `NEXT_PUBLIC_API_URL`.
- Errors: `{error:{code,message}}`.
- Owner auth: `Authorization: Bearer fos_…`.
- Demo auth: `X-Demo-Key`.

**Endpoints:**

```text
GET  /v1/health                         → {ok, network, topicId, asset, version}
GET  /v1/config                         → {network, capability, topicId, operatorId, asset, assetDecimals, mirrorUrl, hashscan,
                                           providers:[{id,name,price,payTo}], baselineAgents, world:{issuer, subStable}}
POST /v1/owner/login/start   {}         → {attemptId, userCode, verificationUri, verificationUriComplete, expiresIn, interval}
GET  /v1/owner/login/:attemptId         → {status:"PENDING"} | {status:"DENIED"|"EXPIRED"|"FAILED", reason}
                                          | {status:"APPROVED", token, human:{humanHash, budgetAccountId}}   (token ONCE)
GET  /v1/me            owner            → {humanHash, budgetAccountId, balance:{asset, amount, display, hbar},
                                           policy:{capPerPayment, dailyCap, allowlist, spentToday},
                                           agents:[{agentAddr,label,accountId,epoch,status,linkedAt,arkivKey}],
                                           pairing:{code,expiresAt}|null, world:{subStable}}
POST /v1/pairings      owner {label}    → {code, expiresAt}
GET  /v1/agents        owner            → {agents:[…]}
POST /v1/agents/:addr/revoke/start owner {} → {approvalId, userCode, verificationUri, verificationUriComplete, expiresIn, interval}
GET  /v1/approvals/:id owner            → {approvalId, kind, status:PENDING|APPROVED|DENIED|EXPIRED|USED, action, digest, expiresAt}
POST /v1/approvals/:id/cancel owner     → {status:"DENIED"}
GET  /v1/policy        owner            → {capPerPayment, dailyCap, allowlist, spentToday}     (base-unit int strings)
PUT  /v1/policy        owner {capPerPayment?, dailyCap?, allowlist?} → same
GET  /v1/jobs/:jobKey  owner            → {jobKey, round, status, winner?, claims:[…], intent?, …}
GET  /v1/intents/:id   owner            → intent (ICD-11)
GET  /v1/counter?jobKey=&since=         → {jobKey, source:"mirror", forkos:{payments, txs[]}, baseline:{payments, txs[]}}
GET  /v1/directory                      → {services:[{key,owner,expiresAt,providerId,capability,network,asset,price,name,endpoint,payTo}]}
GET  /v1/board?jobKey=                  → {claims:[{key,owner,expiresAt,job,round,human,agent,status,epoch,svc,price,seq,tx}]}
GET  /v1/timeline?jobKey=               → {events:[{seq, cts, payer, v, t, …msg}]}
GET  /v1/events                         → SSE
POST /v1/demo/job                 demo  → {audioUrl, inputHash}
POST /v1/chaos/kill-next-payer    demo  → {armed:true}
POST /v1/chaos/fail-next-job      demo  → {armed:true}
POST /v1/chaos/replay/:intentId   demo  → {facilitator:{…, errorReason:"forkos_replay_detected"}}
POST /v1/chaos/revive/:agentAddr  demo {jobKey} → {provider:{status, body}}   (expect 409 STALE_AUTHORITY)
```

**SSE events:**

```text
agent.linked agent.revoked claim.posted claim.won claim.lost approval.pending approval.resolved
intent.created payment.unknown payment.paid payment.void job.done refund.sent counter.update chaos
```

**Facts the UI relies on:**

- FUSD has **6 decimals**. Prices are base units: `scribe-a` 50000 = 0.05, `scribe-b` 40000, `scribe-premium` 2000000 = 2.00. The default cap is 1000000 = 1.00.
- `deadline` is **unix seconds**. Constants: valid duration 120 s, VOID margin 45 s, claim window 30 s, approval TTL 300 s.
- `jobKey = sha256hex("forkos:job:v1|" + humanHash + "|" + capability + "|" + inputHash)`. The frontend computes the same key (F3).
- HashScan transaction link: `${config.hashscan}/transaction/${consensusTimestamp}`. When there's no timestamp yet, link the tx id search `${config.hashscan}/transaction/${txId}`.
- **No API starts agent runs.** The operator runs `pnpm baseline` and `pnpm agents 3` in a terminal. The race page **listens** (SSE + polling) and shows exactly what happened. That is by design: real agents, not a UI simulation.

---

## Phase map

**Part A — Foundation (once)**

| Phase | Output | Time |
|---|---|---|
| F0 | Template copied into `apps/web`, ScanPay code removed | 20 m |
| F1 | Styles: wide shell + lane/clock/board/timeline blocks | 15 m |
| F2 | `lib/env`, `lib/types` (zod), `lib/api` (every ICD-7 call) | 30 m |
| F3 | `lib/session` (owner token), `lib/format`, `lib/jobkey`, `lib/hooks` | 15 m |
| F4 | `lib/events` — one SSE connection, event bus | 20 m |
| F5 | Config, providers, shell + nav, RequireOwner | 25 m |

**Part B — Pages (each: boxes → wiring table → states → code → exit checks)**

| Page | Route | Time |
|---|---|---|
| P1 | `/` landing copy | 25 m |
| P2 | `/login` World device flow | 30 m |
| P3 | `/dashboard` budget · policy · agents · pairing | 45 m |
| P4 | Global World approval sheet (revoke + over-cap) | 30 m |
| P5 | `/race` lanes · death clock · agents · Arkiv board · HCS timeline · feed | 90 m |
| P5b | Chaos panel | 25 m |
| P6 | `/directory` | 20 m |
| P7 | `/proof/[intentId]` | 25 m |

**Part C — Ship:** F6 deploy · F7 demo run · troubleshooting · final checklist.

Build order: F0 → F5, then P2 → P3 → P4 → P5 → P5b → P6 → P7 → P1 last (it's only copy).

---

## F0 — Copy the template into the monorepo

**Goal:** `apps/web` boots on `:3000` with the template look and no ScanPay code.

```bash
# from the forkos repo root
git clone --depth 1 https://github.com/austinjeremiah/Scanpay /tmp/scanpay
mkdir -p apps && cp -R /tmp/scanpay/frontend apps/web
cd apps/web
rm -rf node_modules .next
# ScanPay-only code
rm -f lib/{mera,session,vault,keys,keys.test,sign,chain,originPay,store,useBalances,useMerchant,shared,config}.ts lib/session.tsx lib/config.tsx
rm -rf "app/(app)"/{activity,admin,app,attack-lab,m,merchant,pay,payment,receipt,scan,settings,wallet,welcome}
rm -f public/sw.js components/RegisterSW.tsx
```

Keep: `app/app.css`, `app/(app)/layout.tsx`, `app/(app)/error.tsx`, `app/(site)/*`, `components/{Header,Footer,WebflowRuntime}.tsx`, `components/sections/*`, `components/app/{ui,shell,providers}.tsx` (rewritten in F5), `lib/{api,sse,env,format,hooks}.ts` (rewritten below), `public/{css,js,assets,…}`.

**File: `apps/web/package.json`**

```json
{
  "name": "@forkos/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p ${PORT:-3000}",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.104.2",
    "lucide-react": "^1.55.0",
    "next": "16.4.0",
    "qrcode": "^1.5.4",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "sonner": "^2.0.8",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@types/node": "^24",
    "@types/qrcode": "^1.5.6",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "typescript": "^5"
  }
}
```

**File: `apps/web/next.config.ts`** (replace; no shared alias, no viem)

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  async headers() {
    return [{ source: '/(.*)', headers: [{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }] }];
  },
};
export default nextConfig;
```

**File: `apps/web/.env.example`**

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
# testnet demo only — same value as the API's DEMO_KEY; leave empty to hide the chaos panel
NEXT_PUBLIC_DEMO_KEY=
```

Copy it to `apps/web/.env.local` and fill it in. `.env.local` is already git-ignored by Next. Check that the root `.gitignore` also has `apps/web/.next/`.

**Backend side (one line, tell the backend owner):** in the root `.env`, set `WEB_ORIGIN=http://localhost:3000,https://<your-vercel-domain>`. The backend default is `:5173`, and CORS + SSE will fail without this.

**File: `apps/web/app/layout.tsx`** (replace the ScanPay metadata, drop RegisterSW)

```tsx
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'ForkOS — Agents fork. Money doesn’t.',
  description: 'The exactly-once payment layer for AI agents. Hedera x402 · World ID Agent Pass · Arkiv.',
  icons: { apple: '/apple-touch-icon.png' },
};
export const viewport: Viewport = { themeColor: '#f1efe2', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html data-wf-page="6a901794a3ca5e0a74527ddb" data-wf-site="6a901794a3ca5e0a74527dde" lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
```

Delete `public/manifest.webmanifest`, or edit its `name` to ForkOS. ForkOS isn't a PWA.

**Exit checks**

- [ ] `pnpm install` at the root picks up `@forkos/web` (the workspace already includes `apps/*`)
- [ ] `grep -rn "mera\|passkey\|viem\|@scanpay" apps/web --include=*.ts --include=*.tsx` → only hits in files rewritten in F2–F5 (the build fails until F5, which is expected)
- [ ] Commit: `web: import ScanPay template shell`

---

## F1 — Styles: wide shell + ForkOS blocks

**Goal:** the template's look at desktop width (the race runs on a projector) plus four new blocks: lane, board, timeline row, clock.

Append to **`apps/web/app/app.css`** (keep everything above it):

```css
/* ---------------- ForkOS additions (same tokens, same sharp boxes) ---------------- */
.sp-shell.wide { max-width: 1240px; }
.sp-shell.wide .sp-page { padding: 22px 24px 40px; }
.sp-top .navlinks { display: flex; gap: 4px; margin-left: 12px; }
.sp-top .navlinks a { padding: 8px 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--mute); border: 1px solid transparent; }
.sp-top .navlinks a.active, .sp-top .navlinks a:hover { color: var(--ink); border-color: var(--ink); background: var(--neon); }
@media (max-width: 760px) { .sp-top .navlinks { display: none; } }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
@media (max-width: 900px) { .grid2, .grid3 { grid-template-columns: 1fr; } }

/* lanes */
.lane { border: 1px solid var(--ink); background: var(--pale); display: flex; flex-direction: column; }
.lane .lane-h { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--ink); }
.lane.bad .lane-h { background: var(--bad-bg); }
.lane.ok .lane-h { background: var(--neon); }
.lane .big-n { font-family: var(--font-num); font-size: 96px; line-height: 0.9; letter-spacing: -0.04em; padding: 18px 14px 6px; }
.lane .cap { padding: 0 14px 14px; color: var(--mute); font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; }
.lane .rows { border-top: 1px dashed var(--line); padding: 6px 14px 12px; }
.lane .rows .r { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; padding: 6px 0; border-bottom: 1px dashed var(--line); }

/* agent cards on the race */
.agents-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.agent { border: 1px solid var(--line); background: var(--pale-2); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.agent.won { border-color: var(--ink); background: var(--neon); }
.agent.lost { opacity: 0.6; }
.agent.revoked { background: var(--bad-bg); }

/* death clock */
.clock { border: 1px solid var(--ink); padding: 14px; display: flex; align-items: center; gap: 16px; background: var(--pale); }
.clock .t { font-family: var(--font-num); font-size: 48px; line-height: 1; min-width: 120px; }
.clock .bar { flex: 1; height: 10px; background: var(--pale-2); border: 1px solid var(--ink); position: relative; }
.clock .bar i { position: absolute; inset: 0 auto 0 0; background: var(--ink); }
.clock.void { background: var(--bad-bg); }
.clock.paid { background: var(--ok-bg); }

/* board + timeline tables */
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--mute); padding: 6px 8px; border-bottom: 1px solid var(--ink); }
.tbl td { padding: 8px; border-bottom: 1px dashed var(--line); vertical-align: top; }
.tbl tr.win td { background: var(--neon); }
.tbl tr.void td { background: var(--bad-bg); }
.feed { max-height: 380px; overflow: auto; }
.chip-t { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 6px; border: 1px solid var(--ink); text-transform: uppercase; letter-spacing: 0.06em; }
.chip-t.CLAIM { background: var(--info-bg); } .chip-t.INTENT { background: var(--warn-bg); }
.chip-t.PAID, .chip-t.DONE { background: var(--ok-bg); } .chip-t.VOID, .chip-t.REVOKE { background: var(--bad-bg); }
.chip-t.LINK { background: var(--neon); }
.flash { animation: flash 0.9s ease-out; }
@keyframes flash { from { background: var(--neon); } to { background: transparent; } }
```

**Exit checks**

- [ ] No existing class name was changed. Only the block above was appended.
- [ ] Commit: `web: forkos style blocks`

---

## F2 — Env, types, API client

**File: `apps/web/lib/env.ts`**

```ts
// NEXT_PUBLIC_* must be referenced literally so Next inlines them.
export const ENV = {
  API_URL: (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
  DEMO_KEY: process.env.NEXT_PUBLIC_DEMO_KEY ?? '',
};
```

**File: `apps/web/lib/types.ts`**. These are loose zod schemas (`.passthrough()` is not needed in zod 4, since unknown keys are stripped). Only the fields the UI uses are required.

```ts
import { z } from 'zod';

const n = z.coerce.number();
const s = z.string();
const sOpt = z.string().nullable().optional();

export const zConfig = z.object({
  network: s,
  capability: s,
  topicId: s,
  operatorId: s,
  asset: s,
  assetDecimals: n,
  mirrorUrl: s,
  hashscan: s,
  providers: z.array(z.object({ id: s, name: s, price: s.or(n).transform(String), payTo: s })),
  baselineAgents: z.array(s),
  world: z.object({ issuer: s, subStable: z.boolean() }),
});
export type Config = z.infer<typeof zConfig>;

export const zLoginStart = z.object({
  attemptId: s, userCode: s, verificationUri: s, verificationUriComplete: s, expiresIn: n, interval: n,
});
export const zLoginPoll = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'FAILED']),
  reason: sOpt,
  token: s.optional(),
  human: z.object({ humanHash: s, budgetAccountId: s }).optional(),
});

export const zAgent = z.object({
  agentAddr: s, label: s, accountId: s, epoch: n, status: s, linkedAt: s.or(n).transform(String), arkivKey: sOpt,
});
export type Agent = z.infer<typeof zAgent>;

export const zPolicy = z.object({ capPerPayment: s, dailyCap: s, allowlist: z.array(s), spentToday: s });
export type Policy = z.infer<typeof zPolicy>;

export const zMe = z.object({
  humanHash: s,
  budgetAccountId: s,
  balance: z.object({ asset: s, amount: s, display: s.optional(), hbar: s }),
  policy: zPolicy,
  agents: z.array(zAgent),
  pairing: z.object({ code: s, expiresAt: s.or(n).transform(String) }).nullable().optional(),
  world: z.object({ subStable: z.boolean() }).optional(),
});
export type Me = z.infer<typeof zMe>;

export const zPairing = z.object({ code: s, expiresAt: s.or(n).transform(String) });

export const zApprovalStart = z.object({
  approvalId: s, userCode: s, verificationUri: s, verificationUriComplete: s, expiresIn: n, interval: n,
});
export const zApproval = z.object({
  approvalId: s,
  kind: s,
  status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'USED']),
  action: z.unknown(),
  digest: s,
  expiresAt: s.or(n).transform(String),
});

export const INTENT_STATUS = ['CREATED', 'SENT', 'PAYMENT_UNKNOWN', 'PAID', 'DONE', 'REFUNDED', 'REJECTED', 'FAILED', 'VOID'] as const;
export const zIntent = z.object({
  intentId: s,
  jobKey: s,
  round: n,
  agentAddr: s,
  providerId: s,
  payTo: s,
  asset: s,
  amount: s.or(n).transform(String),
  txId: s,
  deadline: n,
  status: z.enum(INTENT_STATUS),
  attempts: n.optional(),
  consensusTimestamp: sOpt,
  lastError: sOpt,
  result: z.any().optional(),
});
export type Intent = z.infer<typeof zIntent>;

export const zJobClaim = z.object({
  seq: n, cts: s.optional(), agent: s, human: s.optional(), epoch: n.optional(), svc: s, price: s.or(n).transform(String),
  arkivKey: sOpt, valid: z.boolean().optional(), reason: sOpt,
});
export const zJob = z.object({
  jobKey: s,
  round: n,
  status: z.enum(['OPEN', 'CLAIMED', 'PAYING', 'PAID', 'DONE', 'REFUNDED']),
  winner: zJobClaim.nullable().optional(),                 // referee ClaimView of the current round's winner
  claims: z.array(zJobClaim).default([]),
  intent: zIntent.nullable().optional(),                   // DB intentPublic (latest round) — the route overrides the HCS one
  onchainIntent: z.object({ seq: n, tx: s, deadline: n }).nullable().optional(), // HCS INTENT seen by the referee
  settled: z.object({ seq: n, tx: s, cts: s }).nullable().optional(),
  history: z.array(z.object({ round: n, tx: s.optional(), seq: n.optional() })).optional(),
  lastSeq: n.optional(),
});
export type Job = z.infer<typeof zJob>;

const zTx = z.object({ txId: s, cts: s, to: s, amount: s.or(n).transform(String) });
export const zCounter = z.object({
  jobKey: s,
  source: s,
  forkos: z.object({ payments: n, txs: z.array(zTx) }),
  baseline: z.object({ payments: n, txs: z.array(zTx) }),
});
export type Counter = z.infer<typeof zCounter>;

export const zService = z.object({
  key: s, owner: s, expiresAt: s, providerId: s, capability: s, network: s, asset: s, price: s, name: s, endpoint: s, payTo: s,
});
export const zDirectory = z.object({ services: z.array(zService) });

export const zBoardClaim = z.object({
  key: s, owner: s, expiresAt: s, job: s, round: n, human: s, agent: s, status: s, epoch: n, svc: s, price: s, seq: n, tx: s,
});
export type BoardClaim = z.infer<typeof zBoardClaim>;
export const zBoard = z.object({ claims: z.array(zBoardClaim) });

// HCS messages are spread into each event, so only seq/cts/t are guaranteed; keep the rest as a record.
export const zTimelineEv = z.looseObject({ seq: n, cts: s, payer: s.optional(), t: s });
export type TimelineEv = z.infer<typeof zTimelineEv>;
export const zTimeline = z.object({ events: z.array(zTimelineEv) });

export const zDemoJob = z.object({ audioUrl: s, inputHash: s });
export const zArmed = z.object({ armed: z.boolean() });
export const zAny = z.any();
```

> `z.looseObject` is zod 4's "keep unknown keys". It is used only for timeline events, because the HCS message fields (`job`, `round`, `agent`, `tx`, …) differ by type.

**File: `apps/web/lib/api.ts`** (keeps the template's `ApiError` + `call`; endpoints replaced)

```ts
import type { ZodType, z } from 'zod';
import { ENV } from './env';
import { session } from './session';
import * as T from './types';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

type Auth = 'none' | 'owner' | 'demo';

async function call<S extends ZodType>(method: 'GET' | 'POST' | 'PUT', path: string, schema: S, opts: { body?: unknown; auth?: Auth } = {}): Promise<z.infer<S>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth === 'owner') {
    const t = session.token();
    if (!t) throw new ApiError('UNAUTHORIZED', 'Sign in with World ID first.', 401);
    headers.authorization = `Bearer ${t}`;
  }
  if (opts.auth === 'demo') headers['x-demo-key'] = ENV.DEMO_KEY;

  let r: Response;
  try {
    r = await fetch(`${ENV.API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the ForkOS API.', 0);
  }
  const text = await r.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { throw new ApiError('INTERNAL', 'Unexpected response from the API.', r.status); }
  if (!r.ok) {
    const e = json.error ?? {};
    if (r.status === 401 && opts.auth === 'owner') session.clear(); // expired/invalid fos_ token → back to /login
    throw new ApiError(e.code ?? 'INTERNAL', e.message ?? `HTTP ${r.status}`, r.status, json);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error('[api] schema mismatch', path, parsed.error.issues);
    throw new ApiError('SCHEMA', `API response for ${path} did not match the contract.`, r.status, parsed.error.issues);
  }
  return parsed.data;
}

const q = encodeURIComponent;

export const api = {
  health: () => call('GET', '/v1/health', T.zAny),
  config: () => call('GET', '/v1/config', T.zConfig),

  loginStart: () => call('POST', '/v1/owner/login/start', T.zLoginStart, { body: {} }),
  loginPoll: (attemptId: string) => call('GET', `/v1/owner/login/${q(attemptId)}`, T.zLoginPoll),

  me: () => call('GET', '/v1/me', T.zMe, { auth: 'owner' }),
  pairing: (label: string) => call('POST', '/v1/pairings', T.zPairing, { auth: 'owner', body: { label } }),
  revokeStart: (agentAddr: string) => call('POST', `/v1/agents/${q(agentAddr)}/revoke/start`, T.zApprovalStart, { auth: 'owner', body: {} }),
  approval: (id: string) => call('GET', `/v1/approvals/${q(id)}`, T.zApproval, { auth: 'owner' }),
  approvalCancel: (id: string) => call('POST', `/v1/approvals/${q(id)}/cancel`, T.zAny, { auth: 'owner', body: {} }),

  policy: () => call('GET', '/v1/policy', T.zPolicy, { auth: 'owner' }),
  putPolicy: (p: Partial<Pick<T.Policy, 'capPerPayment' | 'dailyCap' | 'allowlist'>>) => call('PUT', '/v1/policy', T.zPolicy, { auth: 'owner', body: p }),

  job: (jobKey: string) => call('GET', `/v1/jobs/${q(jobKey)}`, T.zJob, { auth: 'owner' }),
  intent: (id: string) => call('GET', `/v1/intents/${q(id)}`, T.zIntent, { auth: 'owner' }),
  counter: (jobKey: string, since: number) => call('GET', `/v1/counter?jobKey=${q(jobKey)}&since=${since}`, T.zCounter),

  directory: () => call('GET', '/v1/directory', T.zDirectory),
  board: (jobKey: string) => call('GET', `/v1/board?jobKey=${q(jobKey)}`, T.zBoard),
  timeline: (jobKey: string) => call('GET', `/v1/timeline?jobKey=${q(jobKey)}`, T.zTimeline),

  demoJob: () => call('POST', '/v1/demo/job', T.zDemoJob, { auth: 'demo', body: {} }),
  chaosKill: () => call('POST', '/v1/chaos/kill-next-payer', T.zArmed, { auth: 'demo', body: {} }),
  chaosFail: () => call('POST', '/v1/chaos/fail-next-job', T.zArmed, { auth: 'demo', body: {} }),
  chaosReplay: (intentId: string) => call('POST', `/v1/chaos/replay/${q(intentId)}`, T.zAny, { auth: 'demo', body: {} }),
  chaosRevive: (agentAddr: string, jobKey: string) => call('POST', `/v1/chaos/revive/${q(agentAddr)}`, T.zAny, { auth: 'demo', body: { jobKey } }),
};
```

> **Note:** `chaosReplay` sends `{}` as its body. Fastify with `content-type: application/json` and **no** body returns 400 (`FST_ERR_CTP_EMPTY_JSON_BODY`). Every POST here sends `{}`, so that never happens.

**Exit checks**

- [ ] `pnpm --filter @forkos/web typecheck` passes for `lib/` (pages come later)
- [ ] With the API running: in the browser console, `await (await fetch(API+'/v1/config')).json()` parses with `zConfig` (paste it into a scratch test if unsure)
- [ ] Commit: `web: api client on ICD-7`

---

## F3 — Session, format, jobKey, hooks

**File: `apps/web/lib/session.ts`** — the only browser secret is the owner token `fos_…`.

```ts
'use client';
import { useSyncExternalStore } from 'react';

const KEY = 'forkos.owner.v1';
export type OwnerSession = { token: string; humanHash: string; budgetAccountId: string };

const subs = new Set<() => void>();
let cache: OwnerSession | null | undefined;

function read(): OwnerSession | null {
  if (typeof window === 'undefined') return null;
  if (cache !== undefined) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    cache = v && typeof v.token === 'string' && v.token.startsWith('fos_') ? v : null;
  } catch {
    cache = null;
  }
  return cache ?? null;
}
function emit() { subs.forEach((f) => f()); }

export const session = {
  get: read,
  token: () => read()?.token ?? null,
  set(s: OwnerSession) {
    cache = s;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: memory only */ }
    emit();
  },
  clear() {
    cache = null;
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    emit();
  },
  subscribe(f: () => void) { subs.add(f); return () => subs.delete(f); },
};

/** null on the server and when signed out. */
export function useOwner(): OwnerSession | null {
  return useSyncExternalStore(session.subscribe, read, () => null);
}
```

**File: `apps/web/lib/format.ts`** (replaces the viem-based template file; keeps the names `ui.tsx` imports)

```ts
/** base-unit integer string → decimal string, no float error. */
export function formatUnits(v: string | bigint, decimals: number): string {
  let b = BigInt(v);
  const neg = b < 0n;
  if (neg) b = -b;
  const base = 10n ** BigInt(decimals);
  const whole = b / base;
  const frac = (b % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export function formatToken(amount: string | bigint | null | undefined, decimals: number): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(formatUnits(amount, decimals));
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: decimals > 2 ? 4 : 2 });
}

/** "0.05" → "50000" for 6 decimals; null when invalid. */
export function parseUnits(input: string, decimals: number): string | null {
  const s = input.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) return null;
  return (BigInt(w!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0')).toString();
}

export function formatFiat(usd: number, rate: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(usd * rate);
}

export function countdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return '0:00';
  const m = Math.floor(secondsLeft / 60);
  return `${m}:${String(secondsLeft % 60).padStart(2, '0')}`;
}

export const short = (h?: string | null, n = 6) => (h ? (h.length > 2 * n + 3 ? `${h.slice(0, n)}…${h.slice(-4)}` : h) : '—');

/** Accepts unix seconds (number/"1730…"), ISO strings or Hedera "sss.nnnnnnnnn". */
export function toUnix(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  if (/^\d+(\.\d+)?$/.test(v)) return Math.floor(Number(v.split('.')[0]));
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

export function clock(unix: number): string {
  return unix ? new Date(unix * 1000).toLocaleTimeString(undefined, { hour12: false }) : '—';
}

/** SDK tx id "0.0.123@1730000000.123456789" → Mirror id "0.0.123-1730000000-123456789". */
export function toMirrorTxId(txId: string): string {
  const [acct, ts = ''] = txId.split('@');
  return ts ? `${acct}-${ts.replace('.', '-')}` : txId;
}

/** HashScan links. `base` = config.hashscan (e.g. https://hashscan.io/testnet). */
export const hs = {
  tx: (base: string, consensusTs?: string | null) => (consensusTs ? `${base}/transaction/${consensusTs}` : undefined),
  account: (base: string, id: string) => `${base}/account/${id}`,
  token: (base: string, id: string) => `${base}/token/${id}`,
  topic: (base: string, id: string) => `${base}/topic/${id}`,
};
```

**File: `apps/web/lib/hooks.ts`** (replace — keep only `useNow`; `ui.tsx` imports it)

```ts
'use client';
import { useEffect, useState } from 'react';

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
```

**File: `apps/web/lib/jobkey.ts`** — identical to backend `jobKeyOf` (`packages/shared`), so the race page can lock onto the job **before** the first claim lands.

```ts
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** jobKey = sha256hex("forkos:job:v1|" + humanHash + "|" + capability + "|" + inputHash) */
export async function jobKeyOf(humanHash: string, capability: string, inputHash: string): Promise<string> {
  if (!/^sha256:[0-9a-f]{64}$/.test(inputHash)) throw new Error(`bad inputHash: ${inputHash}`);
  return sha256Hex(`forkos:job:v1|${humanHash}|${capability}|${inputHash}`);
}
```

> `crypto.subtle` needs a secure context: `localhost` or `https`. A LAN IP over http will **not** work — use `localhost` or the Vercel URL.

**Exit checks**

- [ ] `parseUnits('0.05', 6) === '50000'`, `formatToken('2000000', 6) === '2.00'`, `toMirrorTxId('0.0.5@17.000000001') === '0.0.5-17-000000001'`
- [ ] `jobKeyOf` for the backend's P37 run prints the **same** jobKey as `pnpm agents` (compare with the CLI log)
- [ ] Commit: `web: session, format, jobkey`

---

## F4 — One live SSE connection (`lib/events.tsx`)

**Why one connection:** every page needs live updates. One `EventSource` on `/v1/events` feeds a bus. Pages subscribe by event name. The browser's EventSource reconnects by itself and sends `Last-Event-ID`, and the backend replays missed events. On every (re)open we also invalidate all queries, so REST state resyncs.

Delete `lib/sse.ts` (the template's per-path hook).

**File: `apps/web/lib/events.tsx`**

```tsx
'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ENV } from './env';

export const EVENT_TYPES = [
  'agent.linked', 'agent.revoked',
  'claim.posted', 'claim.won', 'claim.lost',
  'approval.pending', 'approval.resolved',
  'intent.created', 'payment.unknown', 'payment.paid', 'payment.void',
  'job.done', 'refund.sent', 'counter.update', 'chaos',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type FosEvent = { type: EventType; at: number; id?: string; data: Record<string, any> };
type Handler = (e: FosEvent) => void;

type Ctx = { status: 'connecting' | 'live' | 'down'; recent: FosEvent[]; on: (types: EventType[] | '*', h: Handler) => () => void };
const EventsCtx = createContext<Ctx | null>(null);

export function EventsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const handlers = useRef(new Set<{ types: EventType[] | '*'; h: Handler }>());
  const [status, setStatus] = useState<Ctx['status']>('connecting');
  const [recent, setRecent] = useState<FosEvent[]>([]);

  useEffect(() => {
    const es = new EventSource(`${ENV.API_URL}/v1/events`);
    const listener = (type: EventType) => (m: MessageEvent) => {
      let data: Record<string, any> = {};
      try { data = JSON.parse(m.data); } catch { return; }
      const ev: FosEvent = { type, at: Date.now(), id: m.lastEventId || undefined, data };
      setRecent((r) => [ev, ...r].slice(0, 80));
      handlers.current.forEach(({ types, h }) => { if (types === '*' || types.includes(type)) h(ev); });
    };
    const ls = EVENT_TYPES.map((t) => [t, listener(t)] as const);
    ls.forEach(([t, f]) => es.addEventListener(t, f as EventListener));
    es.onopen = () => { setStatus('live'); qc.invalidateQueries(); };
    es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'down' : 'connecting');
    return () => { ls.forEach(([t, f]) => es.removeEventListener(t, f as EventListener)); es.close(); };
  }, [qc]);

  const on: Ctx['on'] = (types, h) => {
    const entry = { types, h };
    handlers.current.add(entry);
    return () => { handlers.current.delete(entry); };
  };
  return <EventsCtx.Provider value={{ status, recent, on }}>{children}</EventsCtx.Provider>;
}

export function useEvents() {
  const c = useContext(EventsCtx);
  if (!c) throw new Error('useEvents outside EventsProvider');
  return c;
}

/** Subscribe for the component's lifetime. The handler may change every render. */
export function useEvent(types: EventType[] | '*', handler: Handler) {
  const { on } = useEvents();
  const ref = useRef(handler);
  ref.current = handler;
  const key = types === '*' ? '*' : types.join(',');
  useEffect(() => on(types, (e) => ref.current(e)), [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
```

**Exit checks**

- [ ] DevTools → Network → `events` shows `EventStream` with `: ping` every 15 s
- [ ] Stop the API: the pill (F5) shows **Reconnecting**. Start it: **Live**, and the queries refetch
- [ ] Commit: `web: single SSE bus`

---

## F5 — Providers, config, shell

**File: `apps/web/lib/config.tsx`**

```tsx
'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Config } from './types';

type Ctx = { cfg: Config | null; error: unknown; loading: boolean };
const ConfigCtx = createContext<Ctx>({ cfg: null, error: null, loading: true });

export function ConfigProvider({ children }: { children: ReactNode }) {
  const q = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: 10 * 60_000, retry: 2 });
  return <ConfigCtx.Provider value={{ cfg: q.data ?? null, error: q.error, loading: q.isLoading }}>{children}</ConfigCtx.Provider>;
}
export const useConfig = () => useContext(ConfigCtx);

/** Format a base-unit FUSD amount with the decimals from /v1/config (6). */
export function useDecimals() {
  return useConfig().cfg?.assetDecimals ?? 6;
}
```

**File: `apps/web/components/app/providers.tsx`** (replace — no passkey/onboarding sheets)

```tsx
'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { ConfigProvider } from '@/lib/config';
import { EventsProvider } from '@/lib/events';
import { ApiError } from '@/lib/api';
import { ApprovalProvider } from './approvals';

/** One place that turns errors into toasts (ICD-12 codes → human text). */
export function report(e: unknown) {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      NETWORK: 'Cannot reach the ForkOS API.',
      UNAUTHORIZED: 'Session expired — sign in with World ID again.',
      FORBIDDEN: 'Not allowed (demo key or owner token missing).',
      SCHEMA: 'API and web are out of sync — check the console.',
    };
    return void toast.error(map[e.code] ?? `${e.code}: ${e.message}`);
  }
  toast.error(e instanceof Error ? e.message : 'Something went wrong.');
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }));
  return (
    <QueryClientProvider client={qc}>
      <ConfigProvider>
        <EventsProvider>
          <ApprovalProvider>
            {children}
            <Toaster position="bottom-right" richColors closeButton />
          </ApprovalProvider>
        </EventsProvider>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
```

`ApprovalProvider` is written in **Page P4**. Until then, create a stub `components/app/approvals.tsx` that exports `export function ApprovalProvider({ children }: { children: React.ReactNode }) { return <>{children}</>; }`.

`app/(app)/layout.tsx` stays exactly as in the template: the `.sp` wrapper, Google Fonts link and `<AppProviders>`.

**File: `apps/web/components/app/shell.tsx`** (replace — top bar with links, no bottom nav, wide by default)

```tsx
'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { GitFork, LogOut, Radio, WifiOff } from 'lucide-react';
import { useConfig } from '@/lib/config';
import { useEvents } from '@/lib/events';
import { session, useOwner } from '@/lib/session';
import { Notice, Pill, Spinner } from './ui';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/race', label: 'Race' },
  { href: '/directory', label: 'Directory' },
];

export function AppShell({ title, children, right, narrow }: { title?: string; children: ReactNode; right?: ReactNode; narrow?: boolean }) {
  const path = usePathname();
  const owner = useOwner();
  const { cfg, error } = useConfig();
  const { status } = useEvents();
  return (
    <div className={`sp-shell ${narrow ? '' : 'wide'}`}>
      {status === 'down' && <div className="sp-banner warn"><WifiOff size={16} /> Live updates are off — reconnecting…</div>}
      <header className="sp-top">
        <Link href="/" className="sp-brand" aria-label="ForkOS home">
          <span className="mark"><GitFork size={16} /></span>ForkOS
        </Link>
        <nav className="navlinks">
          {NAV.map((n) => <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? 'active' : ''}>{n.label}</Link>)}
        </nav>
        <div className="title">{title ?? ''}</div>
        {right}
        <Pill tone={status === 'live' ? 'ok' : 'warn'} icon={Radio}>{status === 'live' ? 'Live' : 'Reconnecting'}</Pill>
        {cfg && <Pill tone="ink">{cfg.network}</Pill>}
        {owner && (
          <button className="sp-icon-btn" title="Sign out" aria-label="Sign out" onClick={() => { session.clear(); location.href = '/login'; }}>
            <LogOut size={16} />
          </button>
        )}
      </header>
      <main className="sp-page">
        {error && !cfg ? <Notice tone="bad"><b>Can’t reach the ForkOS API.</b> Check <code>NEXT_PUBLIC_API_URL</code> and the API’s <code>WEB_ORIGIN</code>.</Notice> : children}
      </main>
    </div>
  );
}

/** Wrap owner-only pages. Redirects to /login?next=… when there is no fos_ token. */
export function RequireOwner({ children }: { children: ReactNode }) {
  const owner = useOwner();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (typeof window !== 'undefined' && !session.get()) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [owner, path, router]);
  if (!owner) return <div className="center" style={{ padding: 40 }}><Spinner /></div>;
  return <>{children}</>;
}
```

**File: `apps/web/app/(app)/error.tsx`** (replace if it imports removed modules)

```tsx
'use client';
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="sp-shell"><main className="sp-page">
      <div className="notice bad"><div><b>Something broke.</b> {error.message}</div></div>
      <button className="btn" onClick={reset}>Try again</button>
    </main></div>
  );
}
```

`components/app/ui.tsx` is **kept as is**. It now imports `formatToken/formatFiat/countdown` from the new `lib/format.ts` and `useNow` from `lib/hooks.ts`, and both exist. `MerchantAvatar`, `VerifiedBadge`, `IndexedTag` and `Keypad` are unused and harmless. Delete them later if you like.

**Exit checks**

- [ ] `pnpm --filter @forkos/web typecheck` is green with the stub approvals file
- [ ] An empty page wrapped in `<AppShell>` shows the brand, 3 links, the **Live** pill and `testnet`
- [ ] Commit: `web: shell, providers, config`

---

# Part B — Pages (what's on each page and how it's wired)

Every page section has the same four parts: **Boxes** (what's on screen, top to bottom), **Wiring** (data source → element), **States**, **Code**, then exit checks.

---

## P1 — `/` Landing (template `(site)`)

**Boxes:** Header → Hero → Features (3 sponsor pillars) → Process (how it works, 4 steps) → FAQ → CTA → Footer.
**Wiring:** static. There is no API call. The CTA buttons link to `/login` and `/race`.

**File: `apps/web/app/(site)/page.tsx`** — trim the sections (keep the components; only remove imports you don't render).

```tsx
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import Hero from '@/components/sections/Hero';
import Features from '@/components/sections/Features';
import Process from '@/components/sections/Process';
import Faq from '@/components/sections/Faq';
import Cta from '@/components/sections/Cta';

export default function Page() {
  return (
    <div id="Page-Wrapper" className="page-wrapper">
      <Header /><Hero /><Features /><Process /><Faq /><Cta /><Footer />
    </div>
  );
}
```

Copy to paste into the section components. **Replace text nodes only.** Keep every class name and `data-w-*` attribute, because the Webflow runtime animations depend on them.

| Section | Text |
|---|---|
| Header nav | `How it works` (#process) · `Race demo` (/race) · `Directory` (/directory) · button `Sign in with World ID` (/login) |
| Hero H1 | **Agents fork. Money doesn’t.** |
| Hero sub | ForkOS is the exactly-once payment layer for AI agents. Run ten copies of your agent; your budget pays for the job once — provably — on Hedera. |
| Hero buttons | `Watch the race` → /race · `Sign in with World ID` → /login |
| Features 1 | **Hedera — the death clock.** Every x402 payment carries its own transaction id and a 120-second life. Mirror Node says PAID, or after the clock it proves VOID. HCS referees which fork may pay. |
| Features 2 | **World ID Agent Pass — a human behind every agent.** Link, fire and over-cap spend need a real human’s approval in World App. Revoked agents are fenced out instantly. |
| Features 3 | **Arkiv — live state agents own.** Services, agent links and claims are Arkiv entities owned by the agents’ own wallets, and they expire by themselves. |
| Process | 1 `Link` — approve your agent in World App · 2 `Claim` — forks race, HCS picks the first valid claim · 3 `Pay once` — one intent, one tx id, one death clock · 4 `Prove` — Mirror Node counter: baseline 3, ForkOS 1 |
| FAQ | *What if the payer crashes mid-payment?* The same signed bytes are resent; the tx id is the idempotency key. After the deadline Mirror proves it never landed. · *What if a fired agent comes back?* Its epoch is stale; the provider fence returns 409. · *Who holds the money?* Your Hedera budget account; providers refund in HTS on failure. |
| CTA | **Stop paying twice for the same job.** · `Open the dashboard` → /dashboard |
| Footer | `ForkOS · ETHGlobal Mumbai 2026 · Hedera · World · Arkiv` · GitHub repo link |

Swap the template images for plain blocks/neon boxes if they show ScanPay screenshots. `public/assets/*` can stay.

**Exit checks:** `/` renders with Webflow animations; no "ScanPay" string is left (`grep -ri scanpay apps/web/components apps/web/app` → 0 hits).

---

## P2 — `/login` World ID Agent Pass sign-in

**Boxes:**
1. Title card "Sign in as the human behind your agents".
2. Big **Sign in with World ID** button.
3. After start: QR (verificationUriComplete), user code in big digits with copy, "Open World App" link, expiry countdown, "Waiting for approval…" StepList.
4. Final: Approved → redirect, Denied/Expired/Failed → StateBlock with Retry.

**Wiring**

| Element | Source | Auth |
|---|---|---|
| Start button | `POST /v1/owner/login/start {}` → `attemptId, userCode, verificationUriComplete, expiresIn, interval` | none |
| QR / code / link | the start response fields | — |
| Countdown | `now + expiresIn` | — |
| Poll | `GET /v1/owner/login/:attemptId` every `max(interval, 2)` s | none |
| On `APPROVED` | store `{token, human.humanHash, human.budgetAccountId}` with `session.set` → `router.replace(next ?? '/dashboard')` | — |

**Critical:**

- The token comes back **once**. Every later poll says `PENDING`. So the poller **always stores the token the moment it sees it**, even when the component already unmounted (React StrictMode double-mount in dev).
- Only one poll is in flight at a time.
- Never log the response.

**File: `apps/web/app/(app)/login/page.tsx`**

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fingerprint, Globe, RotateCcw, ShieldAlert, Smartphone } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { CopyButton, Countdown, QrView, StateBlock, StepList, Spinner, Notice } from '@/components/app/ui';
import { report } from '@/components/app/providers';
import { api } from '@/lib/api';
import { session, useOwner } from '@/lib/session';

type Start = Awaited<ReturnType<typeof api.loginStart>>;
type Phase = { k: 'idle' } | { k: 'waiting'; s: Start; until: number } | { k: 'done'; status: 'DENIED' | 'EXPIRED' | 'FAILED'; reason?: string | null };

export default function LoginPage() {
  const router = useRouter();
  const next = useSearchParams().get('next') || '/dashboard';
  const owner = useOwner();
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);

  useEffect(() => { if (owner) router.replace(next); }, [owner, next, router]);

  const start = async () => {
    setBusy(true);
    try {
      const s = await api.loginStart();
      setPhase({ k: 'waiting', s, until: Math.floor(Date.now() / 1000) + s.expiresIn });
    } catch (e) { report(e); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (phase.k !== 'waiting') return;
    let alive = true;
    const every = Math.max(phase.s.interval, 2) * 1000;
    const tick = async () => {
      if (inflight.current) return;
      inflight.current = true;
      try {
        const r = await api.loginPoll(phase.s.attemptId);
        if (r.status === 'APPROVED' && r.token && r.human) {
          // store even if unmounted — the token is handed out exactly once
          session.set({ token: r.token, humanHash: r.human.humanHash, budgetAccountId: r.human.budgetAccountId });
          return; // the useOwner effect redirects
        }
        if (alive && (r.status === 'DENIED' || r.status === 'EXPIRED' || r.status === 'FAILED')) setPhase({ k: 'done', status: r.status, reason: r.reason });
      } catch { /* transient — keep polling */ } finally { inflight.current = false; }
    };
    const t = setInterval(tick, every);
    tick();
    return () => { alive = false; clearInterval(t); };
  }, [phase]);

  return (
    <AppShell narrow title="Sign in">
      <div className="col gap-l">
        <div>
          <div className="eyebrow">World ID Agent Pass</div>
          <h1 className="display">Sign in as the <span className="hl">human</span> behind your agents</h1>
        </div>

        {phase.k === 'idle' && (
          <div className="card col">
            <p className="muted">Your agents spend from one budget tied to one verified human. Linking, firing and over-cap payments always come back to World App for approval.</p>
            <button className="btn big block" onClick={start} disabled={busy}>{busy ? <Spinner /> : <Globe size={20} />} Sign in with World ID</button>
          </div>
        )}

        {phase.k === 'waiting' && (
          <div className="card col center">
            <QrView payload={phase.s.verificationUriComplete} size={240} />
            <div className="eyebrow">or enter this code in World App</div>
            <div className="row" style={{ gap: 8 }}>
              <span className="amount xl mono">{phase.s.userCode}</span>
              <CopyButton text={phase.s.userCode} />
            </div>
            <a className="btn ghost block" href={phase.s.verificationUriComplete} target="_blank" rel="noreferrer"><Smartphone size={18} /> Open World App</a>
            <Countdown until={phase.until} label="Expires in" onExpire={() => setPhase({ k: 'done', status: 'EXPIRED' })} />
            <StepList steps={[
              { label: 'Code issued', state: 'done' },
              { label: 'Approve in World App', state: 'active', icon: Fingerprint },
              { label: 'Budget account ready', state: 'todo' },
            ]} />
          </div>
        )}

        {phase.k === 'done' && (
          <StateBlock
            icon={ShieldAlert}
            tone="bad"
            title={phase.status === 'DENIED' ? 'Denied in World App' : phase.status === 'EXPIRED' ? 'Code expired' : 'Sign-in failed'}
            message={phase.reason ?? 'Nothing was linked. Start again.'}
            action={<button className="btn" onClick={() => setPhase({ k: 'idle' })}><RotateCcw size={16} /> Try again</button>}
          />
        )}

        <Notice tone="info">The web app never sees your World identity — only a hashed human id and a session token.</Notice>
      </div>
    </AppShell>
  );
}
```

> **Next 16:** `useSearchParams()` in a client page needs a `<Suspense>` boundary at build time. Add **`app/(app)/login/layout.tsx`**: `import { Suspense } from 'react'; export default function L({ children }: { children: React.ReactNode }) { return <Suspense>{children}</Suspense>; }`. Do the same for `/race`, which also reads search params.

**States:**

| State | UI |
|---|---|
| idle | button |
| waiting | QR + code + countdown |
| API down | toast "Cannot reach the ForkOS API" |
| DENIED | red StateBlock. This is the **denied-path demo for World**: press Deny on the phone. |
| EXPIRED | countdown hit 0, or the API said EXPIRED |
| APPROVED | redirect |

**Exit checks**

- [ ] Approve on the phone → lands on `/dashboard`. `localStorage['forkos.owner.v1']` holds `fos_…`.
- [ ] Deny on the phone → red "Denied in World App" within one poll interval
- [ ] Reload `/login` while signed in → redirects straight away
- [ ] Commit: `web: world id login`

---

## P3 — `/dashboard` Human budget, policy, agents

**Boxes:**
1. **Budget card**: FUSD balance (big Amount), HBAR, budget account → HashScan, token id → HashScan, humanHash short.
2. **Stats3**: cap per payment · daily cap · spent today.
3. **Policy card** (edit): cap and daily cap inputs (in FUSD), allowlist checkboxes per provider with price, Save.
4. **Agents card**: one row per agent with label, address, Hedera account link, epoch, status pill, linked time and **Revoke** (opens the World approval sheet, P4).
5. **Link an agent card**: CLI command with copy. If `world.subStable === false`, a "Get pairing code" button and the current code with a countdown.
6. Live strip: last 5 events for this human.

**Wiring**

| Element | Source | Refresh |
|---|---|---|
| Everything in 1–4 | `GET /v1/me` (owner), queryKey `['me']` | SSE `agent.linked`, `agent.revoked`, `approval.resolved`, `payment.paid`, `refund.sent`, `job.done` → `invalidate(['me'])`; plus 15 s poll for the Mirror balance |
| Provider names/prices | `cfg.providers` from `/v1/config` | static |
| Save policy | `PUT /v1/policy {capPerPayment, dailyCap, allowlist}`, base-unit strings via `parseUnits(x, 6)` | `setQueryData(['me'])` |
| Revoke | `useApprovals().revoke(agentAddr)` → `POST /v1/agents/:addr/revoke/start` | sheet polls the approval |
| Pairing | `POST /v1/pairings {label}` → `{code, expiresAt}` | `invalidate(['me'])` |
| Link command | static: `pnpm --filter @forkos/agents link "<label>" [pairingCode]` | — |

**File: `apps/web/app/(app)/dashboard/page.tsx`**

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ExternalLink, KeyRound, Save, ShieldCheck, Terminal, Wallet, UserX } from 'lucide-react';
import { AppShell, RequireOwner } from '@/components/app/shell';
import { Amount, CopyButton, Countdown, Notice, Pill, Skeleton, Spinner } from '@/components/app/ui';
import { report } from '@/components/app/providers';
import { useApprovals } from '@/components/app/approvals';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { useEvent, useEvents } from '@/lib/events';
import { formatToken, formatUnits, hs, parseUnits, short, toUnix, clock } from '@/lib/format';
import type { Me } from '@/lib/types';

export default function DashboardPage() {
  return <RequireOwner><AppShell title="Dashboard"><Dashboard /></AppShell></RequireOwner>;
}

function Dashboard() {
  const qc = useQueryClient();
  const { cfg } = useConfig();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 15_000 });
  useEvent(['agent.linked', 'agent.revoked', 'approval.resolved', 'payment.paid', 'refund.sent', 'job.done'], () => qc.invalidateQueries({ queryKey: ['me'] }));

  if (me.isLoading || !cfg) return <div className="col"><Skeleton h={120} /><Skeleton h={80} /><Skeleton h={200} /></div>;
  if (me.error || !me.data) return <Notice tone="bad">Could not load your budget. {(me.error as Error)?.message}</Notice>;
  const m = me.data;
  const d = cfg.assetDecimals;

  return (
    <div className="col gap-l">
      <div className="grid2">
        <div className="card col">
          <div className="eyebrow"><Wallet size={12} /> Human budget · Hedera HTS</div>
          <Amount value={m.balance.amount} decimals={d} symbol="FUSD" size="xl" />
          <div className="kv"><span className="k">HBAR (fees)</span><span className="v">{Number(m.balance.hbar).toFixed(2)}</span></div>
          <div className="kv"><span className="k">Budget account</span><span className="v"><a className="link" href={hs.account(cfg.hashscan, m.budgetAccountId)} target="_blank" rel="noreferrer">{m.budgetAccountId} <ExternalLink size={12} /></a></span></div>
          <div className="kv"><span className="k">Token</span><span className="v"><a className="link" href={hs.token(cfg.hashscan, cfg.asset)} target="_blank" rel="noreferrer">{cfg.asset} <ExternalLink size={12} /></a></span></div>
          <div className="kv"><span className="k">Human (hashed)</span><span className="v mono">{short(m.humanHash, 8)}</span></div>
        </div>
        <div className="stats3">
          <Stat label="Cap / payment" v={formatToken(m.policy.capPerPayment, d)} />
          <Stat label="Daily cap" v={formatToken(m.policy.dailyCap, d)} />
          <Stat label="Spent today" v={formatToken(m.policy.spentToday, d)} />
        </div>
      </div>

      <div className="grid2">
        <PolicyCard me={m} />
        <LinkCard me={m} />
      </div>

      <AgentsCard me={m} />
      <LiveStrip humanHash={m.humanHash} />
    </div>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return <div className="card stat"><span className="eyebrow">{label}</span><span className="amount lg">{v}</span><span className="small muted">FUSD</span></div>;
}

function PolicyCard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { cfg } = useConfig();
  const d = cfg!.assetDecimals;
  const [cap, setCap] = useState(formatUnits(me.policy.capPerPayment, d));
  const [daily, setDaily] = useState(formatUnits(me.policy.dailyCap, d));
  const [allow, setAllow] = useState<string[]>(me.policy.allowlist);
  useEffect(() => { setCap(formatUnits(me.policy.capPerPayment, d)); setDaily(formatUnits(me.policy.dailyCap, d)); setAllow(me.policy.allowlist); }, [me.policy, d]);

  const save = useMutation({
    mutationFn: () => {
      const c = parseUnits(cap, d), dc = parseUnits(daily, d);
      if (!c || !dc) throw new Error('Enter amounts like 1.00');
      return api.putPolicy({ capPerPayment: c, dailyCap: dc, allowlist: allow });
    },
    onSuccess: (p) => { qc.setQueryData<Me>(['me'], (old) => (old ? { ...old, policy: p } : old)); },
    onError: report,
  });

  return (
    <div className="card col">
      <div className="eyebrow"><ShieldCheck size={12} /> Spend policy</div>
      <label className="field"><span className="label">Cap per payment (FUSD) — above this, World App approval</span>
        <span className="input-wrap"><input className="input" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /></span></label>
      <label className="field"><span className="label">Daily cap (FUSD)</span>
        <span className="input-wrap"><input className="input" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} /></span></label>
      <div className="eyebrow">Allowed providers</div>
      {cfg!.providers.map((p) => (
        <label key={p.id} className="row" style={{ justifyContent: 'space-between' }}>
          <span className="row"><input type="checkbox" checked={allow.includes(p.id)} onChange={(e) => setAllow((a) => (e.target.checked ? [...a, p.id] : a.filter((x) => x !== p.id)))} /> {p.name} <span className="muted small mono">{p.id}</span></span>
          <span className="mono">{formatToken(p.price, d)} FUSD</span>
        </label>
      ))}
      <button className="btn" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Spinner /> : <Save size={16} />} Save policy</button>
    </div>
  );
}

function LinkCard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('Agent D');
  const pair = useMutation({ mutationFn: () => api.pairing(label), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }), onError: report });
  const unstable = me.world?.subStable === false;
  const cmd = `pnpm --filter @forkos/agents link "${label}"${unstable && me.pairing ? ` ${me.pairing.code}` : ''}`;
  return (
    <div className="card col">
      <div className="eyebrow"><Terminal size={12} /> Link an agent</div>
      <p className="small muted">Run this where the agent lives. It prints a World App QR; approve it with the same World ID you signed in with. The agent appears below the moment its HCS <b>LINK</b> lands.</p>
      <label className="field"><span className="label">Agent label</span><span className="input-wrap"><input className="input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /></span></label>
      <div className="row"><code className="mono small grow" style={{ wordBreak: 'break-all' }}>{cmd}</code><CopyButton text={cmd} /></div>
      {unstable && (
        <>
          <Notice tone="warn">This World environment doesn’t give a stable id per human, so linking needs a one-time pairing code.</Notice>
          {me.pairing ? (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="amount lg mono">{me.pairing.code}</span>
              <Countdown until={toUnix(me.pairing.expiresAt)} label="Valid" onExpire={() => qc.invalidateQueries({ queryKey: ['me'] })} />
            </div>
          ) : (
            <button className="btn ghost" onClick={() => pair.mutate()} disabled={pair.isPending}><KeyRound size={16} /> Get pairing code</button>
          )}
        </>
      )}
    </div>
  );
}

function AgentsCard({ me }: { me: Me }) {
  const { cfg } = useConfig();
  const approvals = useApprovals();
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="eyebrow"><Bot size={12} /> Linked agents ({me.agents.length})</div>
        <Pill tone="info">Linked via World · logged on HCS · mirrored on Arkiv</Pill>
      </div>
      {me.agents.length === 0 && <p className="muted">No agents yet — run the link command.</p>}
      <table className="tbl">
        <thead><tr><th>Agent</th><th>Address</th><th>Hedera account</th><th>Epoch</th><th>Status</th><th>Linked</th><th /></tr></thead>
        <tbody>
          {me.agents.map((a) => (
            <tr key={a.agentAddr} className={a.status === 'REVOKED' ? 'void' : ''}>
              <td><b>{a.label}</b></td>
              <td className="mono">{short(a.agentAddr)} <CopyButton text={a.agentAddr} small /></td>
              <td><a className="link mono" href={hs.account(cfg!.hashscan, a.accountId)} target="_blank" rel="noreferrer">{a.accountId}</a></td>
              <td className="mono">{a.epoch}</td>
              <td><Pill tone={a.status === 'ACTIVE' ? 'ok' : 'bad'}>{a.status}</Pill></td>
              <td className="small">{clock(toUnix(a.linkedAt))}</td>
              <td>{a.status === 'ACTIVE' && <button className="btn ghost" style={{ minHeight: 34 }} onClick={() => approvals.revoke(a.agentAddr, a.label)}><UserX size={14} /> Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LiveStrip({ humanHash }: { humanHash: string }) {
  const { recent } = useEvents();
  const mine = recent.filter((e) => !e.data.humanHash || e.data.humanHash === humanHash).slice(0, 5);
  if (!mine.length) return null;
  return (
    <div className="card">
      <div className="eyebrow">Live</div>
      <div className="timeline">{mine.map((e, i) => <div key={e.at + ':' + i} className="ev"><span className={`chip-t`}>{e.type}</span><span className="small mono">{new Date(e.at).toLocaleTimeString()}</span></div>)}</div>
    </div>
  );
}
```

**States:**

- loading → skeletons
- 401 → `session.clear()` in `api.ts` → RequireOwner redirects to `/login`
- 0 agents → hint
- REVOKED row → red row with no button
- subStable=false → pairing block

**Exit checks**

- [ ] The balance equals HashScan's FUSD balance for the budget account
- [ ] Set the cap to `0.01` → Save → stats show `0.01`. A reload keeps it.
- [ ] Run the link CLI and approve → the row appears **without reload** (SSE `agent.linked`)
- [ ] Commit: `web: dashboard`

---

## P4 — Global World approval sheet (revoke + over-cap)

**What it is:** a sheet that pops over **any** page whenever a World approval is needed from this human. It has two triggers:

1. **Revoke** (owner clicked it): `POST /v1/agents/:addr/revoke/start` → open the sheet with the response.
2. **Over-cap payment** (an agent asked): SSE `approval.pending` where `data.humanHash === owner.humanHash` → open the sheet with the event.

Both carry `approvalId, userCode, verificationUriComplete` and an expiry.

**Boxes:** Title (kind) → what you're approving (action key/values) → QR + code + "Open World App" → expiry countdown → status StepList → `Cancel` button.

**Wiring**

| Element | Source |
|---|---|
| open | `revoke()` response or SSE `approval.pending` (dedupe by `approvalId`) |
| status | poll `GET /v1/approvals/:id` every 2 s while open, plus SSE `approval.resolved {approvalId, status}` |
| close OK | `APPROVED` or `USED` → toast success, `invalidate(['me'])`, `invalidate(['job'])` |
| close bad | `DENIED`/`EXPIRED` → red StateBlock, then Close |
| Cancel | `POST /v1/approvals/:id/cancel` → `{status:"DENIED"}` |

**File: `apps/web/components/app/approvals.tsx`** (replaces the F5 stub)

```tsx
'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgeCheck, Fingerprint, ShieldAlert, Smartphone, UserX, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useEvent } from '@/lib/events';
import { session } from '@/lib/session';
import { toUnix } from '@/lib/format';
import { CopyButton, Countdown, QrView, Sheet, StateBlock, StepList } from './ui';

type Open = {
  approvalId: string;
  kind: string; // REVOKE | OVERCAP (LINK is shown by the CLI)
  title: string;
  action: unknown;
  userCode: string;
  uri: string;
  until: number;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'USED';
};
type Ctx = { revoke: (agentAddr: string, label?: string) => Promise<void> };
const C = createContext<Ctx | null>(null);
export const useApprovals = () => {
  const c = useContext(C);
  if (!c) throw new Error('useApprovals outside ApprovalProvider');
  return c;
};

export function ApprovalProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [cur, setCur] = useState<Open | null>(null);

  const revoke = useCallback(async (agentAddr: string, label?: string) => {
    try {
      const r = await api.revokeStart(agentAddr);
      setCur({ approvalId: r.approvalId, kind: 'REVOKE', title: `Fire ${label ?? agentAddr.slice(0, 10)}`, action: { agentAddr }, userCode: r.userCode, uri: r.verificationUriComplete, until: Math.floor(Date.now() / 1000) + r.expiresIn, status: 'PENDING' });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  useEvent(['approval.pending'], (e) => {
    const me = session.get();
    if (!me || e.data.humanHash !== me.humanHash) return;
    setCur((c) => (c?.approvalId === e.data.approvalId ? c : {
      approvalId: e.data.approvalId,
      kind: e.data.kind,
      title: e.data.kind === 'OVERCAP' ? 'Approve an over-cap payment' : e.data.kind === 'REVOKE' ? 'Fire an agent' : 'World approval',
      action: e.data.action,
      userCode: e.data.userCode,
      uri: e.data.verificationUriComplete,
      until: toUnix(e.data.expiresAt) || Math.floor(Date.now() / 1000) + 300,
      status: 'PENDING',
    }));
  });
  useEvent(['approval.resolved'], (e) => setCur((c) => (c && c.approvalId === e.data.approvalId ? { ...c, status: e.data.status } : c)));

  // poll while pending
  useEffect(() => {
    if (!cur || cur.status !== 'PENDING') return;
    const t = setInterval(async () => {
      try {
        const a = await api.approval(cur.approvalId);
        if (a.status !== 'PENDING') setCur((c) => (c && c.approvalId === a.approvalId ? { ...c, status: a.status } : c));
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [cur?.approvalId, cur?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // finish
  useEffect(() => {
    if (!cur) return;
    if (cur.status === 'APPROVED' || cur.status === 'USED') {
      toast.success(cur.kind === 'REVOKE' ? 'Agent fired — its epoch is now stale' : 'Approved in World App');
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['job'] });
      const t = setTimeout(() => setCur(null), 900);
      return () => clearTimeout(t);
    }
  }, [cur?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async () => {
    if (cur?.status === 'PENDING') { try { await api.approvalCancel(cur.approvalId); } catch { /* ignore */ } }
    setCur(null);
  };

  const Icon = cur?.kind === 'REVOKE' ? UserX : cur?.kind === 'OVERCAP' ? Wallet : Fingerprint;
  const rows = cur && cur.action && typeof cur.action === 'object' ? Object.entries(cur.action as Record<string, unknown>) : [];

  return (
    <C.Provider value={{ revoke }}>
      {children}
      <Sheet open={!!cur} onClose={cancel} title={cur?.title} icon={Icon}>
        {cur && (cur.status === 'DENIED' || cur.status === 'EXPIRED') ? (
          <StateBlock icon={ShieldAlert} tone="bad" title={cur.status === 'DENIED' ? 'Denied in World App' : 'Approval expired'}
            message={cur.kind === 'OVERCAP' ? 'No payment was made. The agent gets APPROVAL_DENIED.' : 'Nothing changed.'}
            action={<button className="btn" onClick={() => setCur(null)}>Close</button>} />
        ) : cur && (
          <>
            {rows.length > 0 && (
              <div className="card">{rows.map(([k, v]) => <div className="kv" key={k}><span className="k">{k}</span><span className="v mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span></div>)}</div>
            )}
            <div className="col center">
              <QrView payload={cur.uri} size={220} />
              <div className="row"><span className="amount lg mono">{cur.userCode}</span><CopyButton text={cur.userCode} /></div>
              <a className="btn ghost block" href={cur.uri} target="_blank" rel="noreferrer"><Smartphone size={16} /> Open World App</a>
              <Countdown until={cur.until} label="Expires in" />
            </div>
            <StepList steps={[
              { label: 'Request created', state: 'done' },
              { label: 'Human approves in World App', state: cur.status === 'PENDING' ? 'active' : 'done', icon: Fingerprint },
              { label: cur.kind === 'REVOKE' ? 'REVOKE on HCS · Arkiv link → REVOKED' : 'Payment continues', state: cur.status === 'PENDING' ? 'todo' : 'done', icon: BadgeCheck },
            ]} />
            <button className="btn ghost block" onClick={cancel}>Cancel</button>
          </>
        )}
      </Sheet>
    </C.Provider>
  );
}
```

**Exit checks**

- [ ] Dashboard → Revoke → sheet with QR → approve on the phone → toast "Agent fired" → row turns REVOKED (SSE `agent.revoked`)
- [ ] Deny on the phone → red "Denied in World App" (the **denied path for World**)
- [ ] Policy cap `0.01` → run `pnpm agents 1` → sheet opens **by itself** (SSE `approval.pending`, kind OVERCAP) → approve → the agent's payment continues
- [ ] Commit: `web: world approval sheet`

---

## P5 — `/race` The demo screen (Hedera + Arkiv + World together)

This is the page judges watch. It **only observes**: real agents run in the operator terminal (`pnpm baseline`, `pnpm agents 3`), and the page shows Hedera, Arkiv and HCS proof live.

**Boxes (top → bottom):**

1. **Race bar**:
   - Job lock: current `jobKey` short, plus `Load demo job` / `New race` / paste a jobKey
   - `Follow live` toggle
   - Operator commands with copy buttons
2. **Two lanes** (`grid2`):
   - **Baseline**, red: big number = Mirror payments, caption "stock x402 · 3 agents · 3 wallets", with tx rows linking to HashScan
   - **ForkOS**, neon: big number = Mirror payments, caption "3 forks · 1 budget · exactly once", with tx rows linking to HashScan
   - Footer on both: "Counted from Hedera Mirror Node"
3. **Death clock + job steps**: the clock (`deadline − now`, then the VOID window `deadline + 45`) plus a StepList `Claims → Winner → Intent → Paid/Void → Done/Refunded`, with the round number and closed rounds.
4. **Agents row**: one card per linked agent: won, lost, revoked or stale.
5. **Arkiv claim board** and **HCS timeline** (`grid2`).
6. **Chaos panel** (P5b, only when `NEXT_PUBLIC_DEMO_KEY` is set).
7. **Live feed**: the last 25 SSE events.

**Wiring**

| Element | Source | Refresh |
|---|---|---|
| jobKey | URL `?job=`. Set by `Load demo job` (`POST /v1/demo/job` → `jobKeyOf(owner.humanHash, cfg.capability, inputHash)`), or **auto** by SSE `claim.posted` whose `agentAddr` is one of *my* agents (Follow live) | — |
| since | URL `?since=` (unix s), set to `now − 5` on `Load demo job` / `New race` | — |
| Lanes | `GET /v1/counter?jobKey&since` (no auth) | every 4 s + on `payment.*`, `counter.update`, `refund.sent` |
| Clock, steps, winner | `GET /v1/jobs/:jobKey` (owner) → `status, round, winner, claims, intent (DB), onchainIntent, settled, history` | every 3 s + on any `claim.*`, `intent.created`, `payment.*`, `job.done`, `refund.sent` |
| Board | `GET /v1/board?jobKey` (reads **Arkiv**) | every 4 s + on `claim.*`, `payment.*` |
| Timeline | `GET /v1/timeline?jobKey` (reads **HCS via Mirror**) | every 4 s + on any race event |
| Agent cards | `GET /v1/me` agents (labels/status), joined with `job.claims` by agent address | as in P3 |
| Feed | `useEvents().recent` | live |

Polling is the safety net and SSE is the speed-up. The page is correct even if SSE drops.

**File: `apps/web/app/(app)/race/layout.tsx`**

```tsx
import { Suspense, type ReactNode } from 'react';
export default function L({ children }: { children: ReactNode }) { return <Suspense>{children}</Suspense>; }
```

**File: `apps/web/app/(app)/race/page.tsx`**

```tsx
'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, Download, Play, RotateCcw, Terminal } from 'lucide-react';
import { AppShell, RequireOwner } from '@/components/app/shell';
import { CopyButton, Notice, Pill, Spinner } from '@/components/app/ui';
import { report } from '@/components/app/providers';
import { Lanes } from '@/components/race/lanes';
import { DeathClock, JobSteps } from '@/components/race/clock';
import { AgentsRow } from '@/components/race/agents';
import { Board } from '@/components/race/board';
import { Timeline } from '@/components/race/timeline';
import { Chaos } from '@/components/race/chaos';
import { Feed } from '@/components/race/feed';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { ENV } from '@/lib/env';
import { useEvent, type EventType } from '@/lib/events';
import { short } from '@/lib/format';
import { jobKeyOf } from '@/lib/jobkey';
import { useOwner } from '@/lib/session';

const RACE_EVENTS: EventType[] = ['claim.posted', 'claim.won', 'claim.lost', 'intent.created', 'payment.unknown', 'payment.paid', 'payment.void', 'job.done', 'refund.sent', 'counter.update', 'agent.revoked', 'chaos'];

export default function RacePage() {
  return <RequireOwner><AppShell title="Race"><Race /></AppShell></RequireOwner>;
}

function Race() {
  const sp = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { cfg } = useConfig();
  const owner = useOwner()!;
  const jobKey = sp.get('job');
  const since = Number(sp.get('since') || 0) || Math.floor(Date.now() / 1000) - 300;
  const [follow, setFollow] = useState(true);
  const [paste, setPaste] = useState('');
  const [loading, setLoading] = useState(false);

  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 15_000 });
  const myAgents = new Set((me.data?.agents ?? []).map((a) => a.agentAddr.toLowerCase()));

  const lock = (j: string, s = Math.floor(Date.now() / 1000) - 5) => router.replace(`/race?job=${j}&since=${s}`);

  const loadDemo = async () => {
    if (!cfg) return;
    setLoading(true);
    try {
      const job = await api.demoJob();
      lock(await jobKeyOf(owner.humanHash, cfg.capability, job.inputHash));
    } catch (e) { report(e); } finally { setLoading(false); }
  };

  useEvent(RACE_EVENTS, (e) => {
    if (follow && e.type === 'claim.posted' && e.data.jobKey && e.data.jobKey !== jobKey && myAgents.has(String(e.data.agentAddr).toLowerCase())) {
      lock(e.data.jobKey, since);
    }
    qc.invalidateQueries({ queryKey: ['race'] });
    if (e.type === 'agent.revoked') qc.invalidateQueries({ queryKey: ['me'] });
  });

  const job = useQuery({ queryKey: ['race', 'job', jobKey], queryFn: () => api.job(jobKey!), enabled: !!jobKey, refetchInterval: 3000 });

  return (
    <div className="col gap-l">
      <div className="card row wrap" style={{ justifyContent: 'space-between', gap: 12 }}>
        <div className="col gap-s">
          <div className="eyebrow"><Crosshair size={12} /> Job (same meeting · same human · same capability)</div>
          <div className="row">
            <span className="mono amount md">{jobKey ? short(jobKey, 10) : 'none locked'}</span>
            {jobKey && <CopyButton text={jobKey} small />}
            {job.data && <Pill tone="ink">round {job.data.round}</Pill>}
            {job.data && <Pill tone={job.data.status === 'DONE' || job.data.status === 'PAID' ? 'ok' : job.data.status === 'REFUNDED' ? 'warn' : 'info'}>{job.data.status}</Pill>}
          </div>
        </div>
        <div className="row wrap">
          {ENV.DEMO_KEY && <button className="btn" onClick={loadDemo} disabled={loading}>{loading ? <Spinner /> : <Download size={16} />} Load demo job</button>}
          {jobKey && <button className="btn ghost" onClick={() => lock(jobKey)} title="Reset the baseline window to now"><RotateCcw size={16} /> New race</button>}
          <label className="row small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow live</label>
          <span className="input-wrap" style={{ minWidth: 220 }}>
            <input className="input mono" placeholder="paste jobKey (64 hex)" value={paste} onChange={(e) => setPaste(e.target.value.trim())} />
          </span>
          <button className="btn ghost" disabled={!/^[0-9a-f]{64}$/.test(paste)} onClick={() => lock(paste)}><Play size={16} /> Lock</button>
        </div>
      </div>

      <div className="card row wrap" style={{ gap: 16 }}>
        <span className="eyebrow"><Terminal size={12} /> Operator</span>
        <span className="row"><code className="mono">pnpm baseline</code><CopyButton text="pnpm baseline" small /></span>
        <span className="row"><code className="mono">pnpm agents 3</code><CopyButton text="pnpm agents 3" small /></span>
        <span className="small muted">Real agents run there; this screen only reads Hedera, Arkiv and HCS.</span>
      </div>

      {!jobKey ? (
        <Notice tone="info">Press <b>Load demo job</b> (or just run <code>pnpm agents 3</code> with Follow live on). The page locks onto the job the moment the first claim lands.</Notice>
      ) : (
        <>
          <Lanes jobKey={jobKey} since={since} />
          <div className="grid2">
            <DeathClock job={job.data ?? null} />
            <JobSteps job={job.data ?? null} />
          </div>
          <AgentsRow job={job.data ?? null} agents={me.data?.agents ?? []} />
          <div className="grid2">
            <Board jobKey={jobKey} agents={me.data?.agents ?? []} winnerSeq={job.data?.winner?.seq} />
            <Timeline jobKey={jobKey} job={job.data ?? null} agents={me.data?.agents ?? []} />
          </div>
          {ENV.DEMO_KEY && <Chaos jobKey={jobKey} job={job.data ?? null} agents={me.data?.agents ?? []} />}
        </>
      )}
      <Feed />
    </div>
  );
}
```

### P5.1 Lanes — `components/race/lanes.tsx`

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { clock, formatToken, hs, short, toUnix } from '@/lib/format';
import type { Counter } from '@/lib/types';

export function Lanes({ jobKey, since }: { jobKey: string; since: number }) {
  const q = useQuery({ queryKey: ['race', 'counter', jobKey, since], queryFn: () => api.counter(jobKey, since), refetchInterval: 4000 });
  const c = q.data;
  return (
    <div className="grid2">
      <Lane tone="bad" title="Baseline · stock x402" cap="3 agents · 3 wallets · no coordination" side={c?.baseline} />
      <Lane tone="ok" title="ForkOS" cap="3 forks · 1 human budget · exactly once" side={c?.forkos} />
    </div>
  );
}

function Lane({ tone, title, cap, side }: { tone: 'ok' | 'bad'; title: string; cap: string; side?: Counter['forkos'] }) {
  const { cfg } = useConfig();
  const n = side?.payments ?? 0;
  return (
    <div className={`lane ${tone}`}>
      <div className="lane-h"><b className="eyebrow" style={{ color: 'var(--ink)' }}>{title}</b><span className="small">Hedera Mirror Node</span></div>
      <div key={n} className="big-n flash">{side ? n : '–'}</div>
      <div className="cap">{n === 1 ? 'payment' : 'payments'} · {cap}</div>
      <div className="rows">
        {(side?.txs ?? []).map((t) => (
          <div className="r" key={t.txId}>
            <span className="mono">{short(t.txId, 12)}</span>
            <span>{clock(toUnix(t.cts))}</span>
            <span className="mono">→ {t.to}</span>
            <span className="mono">{formatToken(t.amount, cfg?.assetDecimals ?? 6)}</span>
            {cfg && <a href={hs.tx(cfg.hashscan, t.cts)} target="_blank" rel="noreferrer" className="link"><ExternalLink size={13} /></a>}
          </div>
        ))}
        {side && side.txs.length === 0 && <div className="r muted">no payments yet</div>}
      </div>
    </div>
  );
}
```

### P5.2 Death clock + steps — `components/race/clock.tsx`

The clock states come from backend constants: valid **120 s**, VOID margin **45 s**.

| Intent (`job.intent.status`) | now vs deadline | Clock shows |
|---|---|---|
| none | — | "No payment yet — waiting for the winner" |
| `CREATED`/`SENT`/`PAYMENT_UNKNOWN` | `now < deadline` | **mm:ss to death**, black bar shrinking, tx id |
| same | `deadline ≤ now < deadline+45` | "Clock dead · proving on Mirror" with a countdown to `deadline+45` |
| `PAID`/`DONE`/`REFUNDED` | any | green "PAID at <consensus time>" + HashScan |
| `VOID`/`FAILED`/`REJECTED` | any | red "Proven VOID — money never moved — round N+1 opened" |

```tsx
'use client';
import { ExternalLink, Skull, Timer } from 'lucide-react';
import { StepList, Pill, type StepState } from '@/components/app/ui';
import { useConfig } from '@/lib/config';
import { useNow } from '@/lib/hooks';
import { clock, countdown, hs, short, toUnix } from '@/lib/format';
import type { Job } from '@/lib/types';

const VALID_S = 120, VOID_MARGIN_S = 45;

export function DeathClock({ job }: { job: Job | null }) {
  const now = useNow(1000);
  const { cfg } = useConfig();
  const i = job?.intent;
  if (!i) return <div className="clock"><Timer size={28} /><div className="col gap-s"><b>No payment yet</b><span className="small muted">The HCS referee picks one winner; only it may create the intent.</span></div></div>;

  const paid = ['PAID', 'DONE', 'REFUNDED'].includes(i.status);
  const dead = ['VOID', 'FAILED', 'REJECTED'].includes(i.status);
  const left = i.deadline - now;
  const voidLeft = i.deadline + VOID_MARGIN_S - now;

  if (paid) {
    const cts = i.consensusTimestamp ?? job?.settled?.cts ?? null;
    return (
      <div className="clock paid">
        <div className="t">PAID</div>
        <div className="col gap-s grow">
          <span>at {clock(toUnix(cts))} · tx <span className="mono">{short(i.txId, 14)}</span> · attempts {i.attempts ?? 1}</span>
          {cfg && cts && <a className="link" href={hs.tx(cfg.hashscan, cts)} target="_blank" rel="noreferrer">Open on HashScan <ExternalLink size={12} /></a>}
          <a className="link" href={`/proof/${i.intentId}`}>Proof →</a>
        </div>
      </div>
    );
  }
  if (dead) {
    return (
      <div className="clock void">
        <Skull size={34} />
        <div className="col gap-s">
          <b>Proven {i.status} — money never moved</b>
          <span className="small">tx <span className="mono">{short(i.txId, 14)}</span> absent from Mirror after deadline + {VOID_MARGIN_S}s → round {(job?.round ?? i.round)} opened</span>
          <a className="link" href={`/proof/${i.intentId}`}>Proof →</a>
        </div>
      </div>
    );
  }
  if (left > 0) {
    return (
      <div className="clock">
        <div className="t">{countdown(left)}</div>
        <div className="col gap-s grow">
          <span className="small">Death clock · tx <span className="mono">{short(i.txId, 14)}</span> {i.status === 'PAYMENT_UNKNOWN' && <Pill tone="warn">UNKNOWN — resending same bytes</Pill>}</span>
          <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, (left / VALID_S) * 100))}%` }} /></div>
        </div>
      </div>
    );
  }
  return (
    <div className="clock">
      <div className="t">{countdown(Math.max(0, voidLeft))}</div>
      <div className="col gap-s grow"><b>Clock dead · proving on Mirror Node</b><span className="small muted">Hedera can no longer accept tx {short(i.txId, 12)}. If Mirror still has nothing at 0:00, it is VOID.</span></div>
    </div>
  );
}

export function JobSteps({ job }: { job: Job | null }) {
  const s = job?.status;
  const order = ['OPEN', 'CLAIMED', 'PAYING', 'PAID', 'DONE'];
  const idx = s ? (s === 'REFUNDED' ? 4 : order.indexOf(s)) : -1;
  const st = (k: number): StepState => (idx > k ? 'done' : idx === k ? (k === 4 ? 'done' : 'active') : 'todo');
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow">Job · round {job?.round ?? 0}</span>
        {job?.winner && <Pill tone="neon">winner HCS #{job.winner.seq}</Pill>}
      </div>
      <StepList steps={[
        { label: `Claims on HCS (${job?.claims.length ?? 0})`, state: idx >= 0 ? (idx > 0 ? 'done' : 'active') : 'todo' },
        { label: 'First valid claim wins (referee)', state: st(1) },
        { label: 'One intent · one tx id · 120 s clock', state: st(2) },
        { label: 'Paid on Hedera (Mirror SUCCESS)', state: st(3) },
        { label: s === 'REFUNDED' ? 'Job failed → HTS refund' : 'Transcript + summary delivered', state: s === 'REFUNDED' ? 'error' : st(4) },
      ]} />
      {(job?.history?.length ?? 0) > 0 && (
        <div className="small">Closed rounds: {job!.history!.map((h) => <Pill key={h.round} tone="bad">r{h.round} VOID</Pill>)}</div>
      )}
    </div>
  );
}
```

### P5.3 Agents row — `components/race/agents.tsx`

```tsx
'use client';
import { Bot } from 'lucide-react';
import { Pill } from '@/components/app/ui';
import { short } from '@/lib/format';
import type { Agent, Job } from '@/lib/types';

export function AgentsRow({ job, agents }: { job: Job | null; agents: Agent[] }) {
  if (!agents.length) return null;
  return (
    <div className="agents-row">
      {agents.map((a) => {
        const c = job?.claims.find((x) => x.agent.toLowerCase() === a.agentAddr.toLowerCase());
        const won = !!c && job?.winner?.seq === c.seq;
        const cls = a.status === 'REVOKED' ? 'revoked' : won ? 'won' : c ? 'lost' : '';
        return (
          <div key={a.agentAddr} className={`agent ${cls}`}>
            <div className="row"><Bot size={16} /><b>{a.label}</b></div>
            <span className="mono small">{short(a.agentAddr)} · epoch {a.epoch}</span>
            {a.status === 'REVOKED' ? <Pill tone="bad">REVOKED</Pill>
              : !c ? <Pill>idle</Pill>
              : won ? <Pill tone="ink">WON · pays</Pill>
              : c.valid === false ? <Pill tone="bad">invalid: {c.reason}</Pill>
              : <Pill tone="info">LOST · paid by winner</Pill>}
            {c && <span className="small muted">{c.svc} · HCS #{c.seq}</span>}
          </div>
        );
      })}
    </div>
  );
}
```

### P5.4 Arkiv claim board — `components/race/board.tsx`

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { Pill } from '@/components/app/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { formatToken, short } from '@/lib/format';
import type { Agent } from '@/lib/types';

const TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info' | 'neon' | undefined> = { OPEN: 'info', WON: 'neon', PAYING: 'warn', PAID: 'ok', LOST: undefined, VOID: 'bad' };

export function Board({ jobKey, agents, winnerSeq }: { jobKey: string; agents: Agent[]; winnerSeq?: number }) {
  const { cfg } = useConfig();
  const q = useQuery({ queryKey: ['race', 'board', jobKey], queryFn: () => api.board(jobKey), refetchInterval: 4000 });
  const label = (addr: string) => agents.find((a) => a.agentAddr.toLowerCase() === addr.toLowerCase())?.label ?? short(addr);
  const rows = [...(q.data?.claims ?? [])].sort((a, b) => a.round - b.round || a.seq - b.seq);
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow"><Boxes size={12} /> Claim board · read from Arkiv</span>
        <span className="small muted">entities owned by each agent’s wallet · auto-expire</span>
      </div>
      <div className="feed">
        <table className="tbl">
          <thead><tr><th>r</th><th>Agent</th><th>Service</th><th>Price</th><th>Status</th><th>HCS</th><th>Owner (wallet)</th><th>Expires</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.key} className={c.seq && c.seq === winnerSeq ? 'win' : c.status === 'VOID' ? 'void' : ''}>
                <td>{c.round}</td>
                <td><b>{label(c.agent)}</b></td>
                <td className="mono">{c.svc}</td>
                <td className="mono">{formatToken(c.price, cfg?.assetDecimals ?? 6)}</td>
                <td><Pill tone={TONE[c.status]}>{c.status}</Pill></td>
                <td className="mono">{c.seq ? `#${c.seq}` : '…'}</td>
                <td className="mono" title={c.owner}>{short(c.owner)}</td>
                <td className="mono small">{c.expiresAt}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">No claims on Arkiv for this job yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <span className="small muted">Expires is Arkiv’s own <code>$expiresAt</code> as returned. Rows disappear by themselves when it passes (30 s for losers).</span>
    </div>
  );
}
```

### P5.5 HCS timeline — `components/race/timeline.tsx`

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ScrollText } from 'lucide-react';
import { Pill } from '@/components/app/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { clock, formatToken, hs, short, toUnix } from '@/lib/format';
import type { Agent, Job, TimelineEv } from '@/lib/types';

export function Timeline({ jobKey, job, agents }: { jobKey: string; job: Job | null; agents: Agent[] }) {
  const { cfg } = useConfig();
  const q = useQuery({ queryKey: ['race', 'timeline', jobKey], queryFn: () => api.timeline(jobKey), refetchInterval: 4000 });
  const label = (addr?: unknown) => (typeof addr === 'string' ? agents.find((a) => a.agentAddr.toLowerCase() === addr.toLowerCase())?.label ?? short(addr) : '');
  const d = cfg?.assetDecimals ?? 6;

  const say = (e: TimelineEv): string => {
    const m = e as Record<string, any>;
    switch (e.t) {
      case 'LINK': return `${label(m.agent)} linked · acct ${m.acct} · epoch ${m.epoch}`;
      case 'REVOKE': return `${label(m.agent)} fired · epoch → ${m.epoch}`;
      case 'CLAIM': return `r${m.round} ${label(m.agent)} claims ${m.svc} @ ${formatToken(m.price, d)}`;
      case 'INTENT': return `r${m.round} intent tx ${short(m.tx, 12)} · dies ${clock(Number(m.dl))}`;
      case 'SETTLED': return `r${m.round} SETTLED tx ${short(m.tx, 12)}`;
      case 'VOID': return `r${m.round} VOID tx ${short(m.tx, 12)} → next round`;
      case 'DONE': return `r${m.round} ${m.svc} delivered · out ${short(m.out, 8)}`;
      case 'REFUND': return `r${m.round} refund ${short(m.rtx, 12)} · ${formatToken(m.amt, d)}`;
      case 'APPROVAL': return `World approval · ${m.kind}`;
      default: return e.t;
    }
  };
  const verdict = (e: TimelineEv) => {
    if (e.t !== 'CLAIM') return null;
    const c = job?.claims.find((x) => x.seq === e.seq);
    if (!c) return null;
    if (job?.winner?.seq === e.seq) return <Pill tone="neon">WINNER</Pill>;
    return c.valid === false ? <Pill tone="bad">{c.reason}</Pill> : <Pill>late</Pill>;
  };
  const rows = [...(q.data?.events ?? [])].sort((a, b) => b.seq - a.seq);

  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow"><ScrollText size={12} /> Referee log · Hedera HCS</span>
        {cfg && <a className="link small" href={hs.topic(cfg.hashscan, cfg.topicId)} target="_blank" rel="noreferrer">topic {cfg.topicId} <ExternalLink size={12} /></a>}
      </div>
      <div className="feed">
        <table className="tbl">
          <thead><tr><th>#</th><th>Type</th><th>What</th><th>Referee</th><th>Time</th><th>Payer</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.seq}>
                <td className="mono">{e.seq}</td>
                <td><span className={`chip-t ${e.t}`}>{e.t}</span></td>
                <td className="small">{say(e)}</td>
                <td>{verdict(e)}</td>
                <td className="mono small">{cfg ? <a className="link" href={`${cfg.hashscan}/topic/${cfg.topicId}/message/${e.seq}`} target="_blank" rel="noreferrer">{clock(toUnix(e.cts))}</a> : clock(toUnix(e.cts))}</td>
                <td className="mono small">{e.payer ?? ''}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No HCS messages for this job yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

> If HashScan's per-message URL differs on the day, the topic link in the header still works. Do not block on it.

### P5.6 Live feed — `components/race/feed.tsx`

```tsx
'use client';
import { Activity } from 'lucide-react';
import { useEvents } from '@/lib/events';

export function Feed() {
  const { recent } = useEvents();
  return (
    <div className="card col">
      <span className="eyebrow"><Activity size={12} /> Live events (SSE)</span>
      <div className="feed timeline">
        {recent.slice(0, 25).map((e, i) => (
          <div className="ev" key={`${e.at}:${i}`}>
            <span className={`chip-t`}>{e.type}</span>
            <span className="small mono" style={{ wordBreak: 'break-all' }}>{JSON.stringify(e.data).slice(0, 160)}</span>
          </div>
        ))}
        {recent.length === 0 && <span className="muted small">Waiting for events…</span>}
      </div>
    </div>
  );
}
```

**Exit checks (P5)**

- [ ] `Load demo job` → the jobKey equals the one printed by `pnpm agents` (same formula)
- [ ] `pnpm baseline` → Baseline lane counts up to **3** with 3 HashScan links
- [ ] `pnpm agents 3` → ForkOS lane shows **1**, the board shows 3 claims (1 WON/PAID, 2 LOST), the timeline shows 3 CLAIM + INTENT + SETTLED + DONE, and the clock goes green
- [ ] Rerun `pnpm agents 3` → ForkOS stays **1** (the job is already DONE, so nobody pays twice)
- [ ] Kill the API mid-race → polling resumes after restart. No crash.
- [ ] Commit: `web: race`

---

## P5b — Chaos panel (`components/race/chaos.tsx`)

Each button proves one threat-model row live. Every chaos route needs the **demo key**. The cap buttons use the **owner** token.

| Button | Call | Then (operator) | What the screen must show |
|---|---|---|---|
| **Kill next payer** | `POST /v1/chaos/kill-next-payer` | `pnpm agents 3` | SSE `chaos`, then `payment.unknown`. The clock shows **UNKNOWN — resending same bytes**, then ends PAID (same tx id) or VOID → round 1 → PAID. The ForkOS lane stays **1**. |
| **Fail next job** | `POST /v1/chaos/fail-next-job` | `pnpm agents 3` on a fresh input, or after a backend reset | `refund.sent` toast, a timeline REFUND row, and job status REFUNDED |
| **Replay last payment** | `POST /v1/chaos/replay/:intentId` (needs `job.intent.intentId`) | — | Facilitator result: `errorReason === "forkos_replay_detected"` → green "Replay refused" |
| **Revive fired agent** | `POST /v1/chaos/revive/:agentAddr {jobKey}` | — | `provider.status === 409` and `body.error.code` is `STALE_AUTHORITY` or `NOT_WINNER` → green "Fenced out" |
| **Cap 0.01 / Cap 1.00** | `PUT /v1/policy {capPerPayment:"10000"}` / `"1000000"` | `pnpm agents 1` | The **World approval sheet** (P4) pops up by itself |

```tsx
'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Bomb, Repeat, Skull, Wallet } from 'lucide-react';
import { Notice, Spinner } from '@/components/app/ui';
import { report } from '@/components/app/providers';
import { api } from '@/lib/api';
import { useEvent } from '@/lib/events';
import type { Agent, Job } from '@/lib/types';

type Out = { tone: 'ok' | 'bad' | 'info'; title: string; body: string } | null;

export function Chaos({ jobKey, job, agents }: { jobKey: string; job: Job | null; agents: Agent[] }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<Out>(null);
  const revoked = agents.filter((a) => a.status === 'REVOKED');
  const [revAddr, setRevAddr] = useState('');

  useEvent(['chaos'], (e) => toast.message(`Chaos: ${e.data.kind}`, { description: typeof e.data.detail === 'string' ? e.data.detail : JSON.stringify(e.data.detail) }));
  useEvent(['refund.sent'], () => toast.success('Provider refunded the budget in HTS'));
  useEvent(['payment.unknown'], () => toast.warning('Payment UNKNOWN — the death clock decides'));

  const run = async (k: string, f: () => Promise<Out>) => {
    setBusy(k);
    try { setOut(await f()); } catch (e) { report(e); } finally { setBusy(null); }
  };

  const B = ({ k, icon: I, children, disabled, onClick }: { k: string; icon: typeof Bomb; children: React.ReactNode; disabled?: boolean; onClick: () => void }) => (
    <button className="btn ghost" disabled={!!busy || disabled} onClick={onClick}>{busy === k ? <Spinner /> : <I size={16} />} {children}</button>
  );

  return (
    <div className="card col">
      <span className="eyebrow"><Bomb size={12} /> Chaos — break it on stage</span>
      <div className="row wrap">
        <B k="kill" icon={Skull} onClick={() => run('kill', async () => { await api.chaosKill(); return { tone: 'info', title: 'Armed: kill next payer', body: 'Now run pnpm agents 3. The payer aborts 400 ms after sending; the death clock decides PAID or VOID.' }; })}>Kill next payer</B>
        <B k="fail" icon={Ban} onClick={() => run('fail', async () => { await api.chaosFail(); return { tone: 'info', title: 'Armed: fail next job', body: 'The provider takes the payment, fails, and refunds in HTS. Watch the REFUND row.' }; })}>Fail next job</B>
        <B k="replay" icon={Repeat} disabled={!job?.intent} onClick={() => run('replay', async () => {
          const r = await api.chaosReplay(job!.intent!.intentId);
          const reason = r?.facilitator?.errorReason;
          return reason === 'forkos_replay_detected'
            ? { tone: 'ok', title: 'Replay refused', body: `Facilitator: ${reason}. Same signed bytes cannot settle twice.` }
            : { tone: 'bad', title: 'Unexpected replay result', body: JSON.stringify(r) };
        })}>Replay last payment</B>
        <select className="input" style={{ maxWidth: 200 }} value={revAddr} onChange={(e) => setRevAddr(e.target.value)}>
          <option value="">fired agent…</option>
          {revoked.map((a) => <option key={a.agentAddr} value={a.agentAddr}>{a.label}</option>)}
        </select>
        <B k="revive" icon={Ban} disabled={!revAddr} onClick={() => run('revive', async () => {
          const r = await api.chaosRevive(revAddr, jobKey);
          const code = r?.provider?.body?.error?.code;
          return r?.provider?.status === 409
            ? { tone: 'ok', title: 'Fenced out', body: `Provider answered 409 ${code}. A fired agent’s stale epoch cannot buy.` }
            : { tone: 'bad', title: 'Unexpected revive result', body: JSON.stringify(r) };
        })}>Revive fired agent</B>
        <B k="cap" icon={Wallet} onClick={() => run('cap', async () => { await api.putPolicy({ capPerPayment: '10000' }); qc.invalidateQueries({ queryKey: ['me'] }); return { tone: 'info', title: 'Cap = 0.01 FUSD', body: 'Run pnpm agents 1 — the World approval sheet will open here.' }; })}>Cap 0.01</B>
        <B k="cap2" icon={Wallet} onClick={() => run('cap2', async () => { await api.putPolicy({ capPerPayment: '1000000' }); qc.invalidateQueries({ queryKey: ['me'] }); return { tone: 'info', title: 'Cap = 1.00 FUSD', body: 'Back to normal.' }; })}>Cap 1.00</B>
      </div>
      {out && <Notice tone={out.tone}><b>{out.title}.</b> {out.body}</Notice>}
      {revoked.length === 0 && <span className="small muted">To demo “revive”: revoke an agent on the Dashboard first (World approval).</span>}
    </div>
  );
}
```

**Exit checks**

- [ ] Each button gives the result in the table above against the real backend
- [ ] Without `NEXT_PUBLIC_DEMO_KEY` the panel is hidden
- [ ] Commit: `web: chaos panel`

---

## P6 — `/directory` Service directory (Arkiv)

**Boxes:**
- A header notice: "Read live from Arkiv. Each provider's wallet owns its entry, and it expires unless the provider keeps refreshing it."
- One card per service: name, providerId, price, endpoint, payTo (HashScan), Arkiv owner wallet, entity key (copy), expiresAt.
- A pill "Allowed by your policy" when signed in.

**Wiring:**

- `GET /v1/directory` (no auth), every 15 s.
- `GET /v1/me` only when signed in, for the allowlist.

**File: `apps/web/app/(app)/directory/page.tsx`**

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { Boxes, ExternalLink } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { CopyButton, Notice, Pill, Skeleton } from '@/components/app/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { formatToken, hs, short } from '@/lib/format';
import { useOwner } from '@/lib/session';

export default function DirectoryPage() {
  const { cfg } = useConfig();
  const owner = useOwner();
  const dir = useQuery({ queryKey: ['directory'], queryFn: api.directory, refetchInterval: 15_000 });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: !!owner });
  const allow = new Set(me.data?.policy.allowlist ?? []);
  return (
    <AppShell title="Directory">
      <div className="col gap-l">
        <div>
          <div className="eyebrow"><Boxes size={12} /> Arkiv · forkos.service.v1</div>
          <h1 className="display">Who sells <span className="hl">{cfg?.capability ?? 'transcribe+summarize.v1'}</span></h1>
        </div>
        <Notice tone="info">Read live from Arkiv. Each entry is owned by the provider’s own wallet and expires unless the provider keeps refreshing it — stop a provider and watch it disappear.</Notice>
        {dir.isLoading && <Skeleton h={140} />}
        {dir.error && <Notice tone="bad">Arkiv read failed: {(dir.error as Error).message}</Notice>}
        <div className="grid3">
          {dir.data?.services.map((s) => (
            <div key={s.key} className="card col">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b className="h3">{s.name}</b>
                {owner && <Pill tone={allow.has(s.providerId) ? 'ok' : 'bad'}>{allow.has(s.providerId) ? 'Allowed' : 'Blocked by policy'}</Pill>}
              </div>
              <span className="amount lg">{formatToken(s.price, cfg?.assetDecimals ?? 6)} <span className="small">FUSD / job</span></span>
              <div className="kv"><span className="k">Provider</span><span className="v mono">{s.providerId}</span></div>
              <div className="kv"><span className="k">Network</span><span className="v mono">{s.network}</span></div>
              <div className="kv"><span className="k">Endpoint</span><span className="v mono small">{s.endpoint}</span></div>
              <div className="kv"><span className="k">Pays to</span><span className="v">{cfg ? <a className="link mono" href={hs.account(cfg.hashscan, s.payTo)} target="_blank" rel="noreferrer">{s.payTo} <ExternalLink size={12} /></a> : s.payTo}</span></div>
              <div className="kv"><span className="k">Arkiv owner</span><span className="v mono">{short(s.owner)}</span></div>
              <div className="kv"><span className="k">Entity key</span><span className="v mono">{short(s.key, 8)} <CopyButton text={s.key} small /></span></div>
              <div className="kv"><span className="k">Expires at</span><span className="v mono">{s.expiresAt}</span></div>
            </div>
          ))}
        </div>
        {dir.data && dir.data.services.length === 0 && <Notice tone="warn">No live services on Arkiv — are the providers running?</Notice>}
      </div>
    </AppShell>
  );
}
```

**Exit checks:** 3 cards (scribe-a 0.05, scribe-b 0.04, premium 2.00). Stop `dev:scribe-b`, and after its Arkiv lifetime passes the card disappears. Commit: `web: directory`.

---

## P7 — `/proof/[intentId]` One payment, end-to-end audit

Linked from the race clock and the board, and good for judges: "show me the receipts".

**Boxes:**
1. Header with status pill and amount.
2. **Intent** kv: jobKey, round, agent, provider, payTo, tx id, deadline, attempts, last error.
3. **Hedera**: consensus timestamp + HashScan link, Mirror REST link `${mirrorUrl}/api/v1/transactions/${toMirrorTxId(txId)}`, HCS topic link.
4. **HCS trail** for this job and round (the timeline filtered to `round`).
5. **Arkiv claim** of the paying agent (from the board).
6. **Result**: summary, outputHash or refundTxId.

**Wiring:**

- `GET /v1/intents/:id` (owner).
- `GET /v1/timeline?jobKey` and `GET /v1/board?jobKey`, both from `intent.jobKey`.

**File: `apps/web/app/(app)/proof/[intentId]/page.tsx`**

```tsx
'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileCheck2 } from 'lucide-react';
import { AppShell, RequireOwner } from '@/components/app/shell';
import { Notice, Pill, Skeleton, TechDetails } from '@/components/app/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { clock, formatToken, hs, short, toMirrorTxId, toUnix } from '@/lib/format';

export default function ProofPage() {
  return <RequireOwner><AppShell title="Proof"><Proof /></AppShell></RequireOwner>;
}

function Proof() {
  const { intentId } = useParams<{ intentId: string }>();
  const { cfg } = useConfig();
  const i = useQuery({ queryKey: ['intent', intentId], queryFn: () => api.intent(intentId), refetchInterval: (q) => (q.state.data && ['DONE', 'REFUNDED', 'VOID', 'FAILED'].includes(q.state.data.status) ? false : 3000) });
  const jobKey = i.data?.jobKey;
  const tl = useQuery({ queryKey: ['proof', 'tl', jobKey], queryFn: () => api.timeline(jobKey!), enabled: !!jobKey });
  const bd = useQuery({ queryKey: ['proof', 'bd', jobKey], queryFn: () => api.board(jobKey!), enabled: !!jobKey });

  if (i.isLoading || !cfg) return <Skeleton h={240} />;
  if (!i.data) return <Notice tone="bad">Unknown intent.</Notice>;
  const x = i.data;
  const d = cfg.assetDecimals;
  const trail = (tl.data?.events ?? []).filter((e) => (e as any).round === x.round || e.t === 'LINK').sort((a, b) => a.seq - b.seq);
  const claim = bd.data?.claims.find((c) => c.round === x.round && c.agent.toLowerCase() === x.agentAddr.toLowerCase());
  const r = (x.result ?? {}) as { summary?: string; outputHash?: string; refundTxId?: string };

  return (
    <div className="col gap-l">
      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
        <div><div className="eyebrow"><FileCheck2 size={12} /> Payment proof</div><h1 className="display">{formatToken(x.amount, d)} <span className="hl">FUSD</span></h1></div>
        <Pill tone={x.status === 'DONE' || x.status === 'PAID' ? 'ok' : x.status === 'REFUNDED' ? 'warn' : x.status === 'VOID' ? 'bad' : 'info'}>{x.status}</Pill>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="eyebrow">Intent (stored before sending)</div>
          {[
            ['Job', short(x.jobKey, 10)], ['Round', String(x.round)], ['Agent', short(x.agentAddr)], ['Provider', x.providerId],
            ['Pays to', x.payTo], ['Tx id (ours)', x.txId], ['Dies at', clock(x.deadline)], ['Attempts', String(x.attempts ?? 1)], ['Last error', x.lastError ?? '—'],
          ].map(([k, v]) => <div className="kv" key={k}><span className="k">{k}</span><span className="v mono">{v}</span></div>)}
        </div>
        <div className="card">
          <div className="eyebrow">Hedera</div>
          <div className="kv"><span className="k">Consensus</span><span className="v mono">{x.consensusTimestamp ? `${x.consensusTimestamp} (${clock(toUnix(x.consensusTimestamp))})` : 'not on ledger'}</span></div>
          {x.consensusTimestamp && <div className="kv"><span className="k">HashScan</span><span className="v"><a className="link" href={hs.tx(cfg.hashscan, x.consensusTimestamp)} target="_blank" rel="noreferrer">open <ExternalLink size={12} /></a></span></div>}
          <div className="kv"><span className="k">Mirror REST</span><span className="v"><a className="link" href={`${cfg.mirrorUrl}/api/v1/transactions/${toMirrorTxId(x.txId)}`} target="_blank" rel="noreferrer">raw JSON <ExternalLink size={12} /></a></span></div>
          <div className="kv"><span className="k">HCS topic</span><span className="v"><a className="link" href={hs.topic(cfg.hashscan, cfg.topicId)} target="_blank" rel="noreferrer">{cfg.topicId} <ExternalLink size={12} /></a></span></div>
          <div className="kv"><span className="k">Arkiv claim</span><span className="v mono">{claim ? `${short(claim.key, 8)} · ${claim.status} · owner ${short(claim.owner)}` : '—'}</span></div>
        </div>
      </div>

      <div className="card">
        <div className="eyebrow">HCS trail (round {x.round})</div>
        <div className="timeline">{trail.map((e) => <div className="ev" key={e.seq}><span className={`chip-t ${e.t}`}>{e.t}</span><span className="mono small">#{e.seq} · {clock(toUnix(e.cts))}</span></div>)}</div>
      </div>

      {(r.summary || r.refundTxId) && (
        <div className="card col">
          <div className="eyebrow">{r.refundTxId ? 'Refunded' : 'Delivered'}</div>
          {r.summary && <p>{r.summary}</p>}
          <TechDetails rows={[{ label: 'Output hash', value: r.outputHash }, { label: 'Refund tx', value: r.refundTxId }]} />
        </div>
      )}
    </div>
  );
}
```

The race clock already links here (`Proof →`) in the paid and void states.

> **Next 16:** the dynamic segment `[intentId]` in a **client** page is read with `useParams()`, as above. Don't add a server `params` prop.

**Exit checks:** open the proof for the P5 run. HashScan opens the exact transaction, the Mirror link returns JSON with `result: SUCCESS`, and the trail shows CLAIM → INTENT → SETTLED → DONE. Commit: `web: proof page`.

---

# Part C — Ship it

## F6 — Deploy

**Vercel** (recommended for `apps/web`):

1. New Project → import the repo → **Root Directory `apps/web`**. Framework: Next.js. Install: `pnpm install`. Build: `pnpm build`.
2. Env: `NEXT_PUBLIC_API_URL=https://<api>.up.railway.app`, `NEXT_PUBLIC_DEMO_KEY=<DEMO_KEY>`.
3. Tell the backend owner to set `WEB_ORIGIN=https://<project>.vercel.app,http://localhost:3000` on the Railway API and redeploy. The backend H2 handoff in its doc covers this.

**Railway alternative:** service root `apps/web`, build `pnpm --filter @forkos/web build`, start `pnpm --filter @forkos/web start`, plus the same env vars.

**Exit checks**

- [ ] The production `/race` shows the **Live** pill (SSE through CORS works)
- [ ] The production `/login` works on a phone (HTTPS, so `crypto.subtle` is available)

## F7 — The 4-minute demo run (screen ↔ terminal)

| t | Screen | Operator terminal | Sponsor beat |
|---|---|---|---|
| 0:00 | `/` hero | — | pitch line |
| 0:20 | `/login` → QR → approve on phone | — | **World** device flow |
| 0:40 | `/dashboard`: budget FUSD, 3 agents ACTIVE | (agents linked earlier with `link`) | **Hedera** HTS · **World** link |
| 1:00 | `/directory`: 3 services from Arkiv | — | **Arkiv** |
| 1:15 | `/race` → Load demo job | `pnpm baseline` | baseline lane → **3** |
| 1:45 | same | `pnpm agents 3` | ForkOS lane → **1**; board shows WON/LOST; HCS timeline; clock → PAID; **Hedera + Arkiv** |
| 2:30 | Chaos → Kill next payer | `pnpm agents 3` (fresh job if backend reset) | UNKNOWN → death clock → PAID/VOID; still **1** |
| 3:00 | Chaos → Replay | — | "Replay refused" |
| 3:15 | Dashboard → Revoke Agent C → phone **Deny** → then again **Approve** | — | **World** denied path + approved path |
| 3:35 | Chaos → Revive fired agent | — | "Fenced out 409 STALE_AUTHORITY" |
| 3:50 | `/proof/<id>` → HashScan | — | receipts |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every call fails: "Cannot reach the ForkOS API" | wrong `NEXT_PUBLIC_API_URL`, or CORS | check the URL; the backend `WEB_ORIGIN` must contain the exact origin (scheme + host + port) |
| Pill stuck on **Reconnecting** | SSE blocked by CORS or a proxy buffering | `WEB_ORIGIN`; open `API/v1/events` directly in a tab and it should stream |
| `SCHEMA` toast | the backend changed a field | the console shows the zod issue; align `lib/types.ts` with the backend ICD (backend wins) |
| Login approved but stuck on "waiting" | the token was consumed by another tab or poll | start again. Only one `/login` tab at a time. |
| 401 on dashboard | token invalid after a backend DB reset | auto sign-out → sign in again |
| Race never locks | `Follow live` is off, or the agents belong to another human | Load demo job, or paste the jobKey from the CLI log |
| jobKey differs from the CLI | the capability string differs | `cfg.capability` must equal the backend `CAPABILITY`. Both come from `/v1/config`. |
| `crypto.subtle` undefined | opened over http on a LAN IP | use `localhost` or HTTPS |
| Chaos buttons → FORBIDDEN | `NEXT_PUBLIC_DEMO_KEY` ≠ API `DEMO_KEY` | fix the env and **rebuild** (NEXT_PUBLIC values are inlined at build time) |
| `useSearchParams` build error | missing Suspense | add the `layout.tsx` Suspense wrappers (login, race) |
| Webflow animations broken on `/` | a class name was changed while editing copy | revert; change text nodes only |

## Final checklist

- [ ] No ScanPay strings, no Mera, viem or passkey code (`grep -ri "scanpay\|mera\|passkey" apps/web` → 0)
- [ ] No secrets in the repo: `.env.local` is ignored; only `fos_` lives in localStorage; no `console.log` of tokens
- [ ] Every endpoint in `lib/api.ts` is in backend ICD-7 and every event in `lib/events.tsx` is in ICD-8
- [ ] `pnpm --filter @forkos/web typecheck && pnpm --filter @forkos/web build` is green
- [ ] Demo run F7 done twice end-to-end on the deployed URLs
- [ ] Screenshots for the submission: race (3 vs 1), approval sheet, directory, proof page
