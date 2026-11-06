import { ApiError } from '@forkos/shared';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from './config';
import { decrypt, encrypt, newId } from './crypto';
import { sql, type AttemptRow } from './db';

type Discovery = { issuer: string; device_authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
let disco: Discovery | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function discovery(): Promise<Discovery> {
  if (disco) return disco;
  const res = await fetch(`${env.WORLD_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new ApiError('WORLD_UNAVAILABLE', `discovery failed: ${res.status}`);
  const d = (await res.json()) as Discovery;
  if (!d.device_authorization_endpoint) throw new ApiError('UPSTREAM_FAILED', 'issuer has no device_authorization_endpoint');
  disco = d;
  jwks = createRemoteJWKSet(new URL(d.jwks_uri));
  return d;
}

export type AttemptPublic = {
  attemptId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
};

export function attemptPublic(row: AttemptRow): AttemptPublic {
  return {
    attemptId: row.id,
    userCode: row.user_code,
    verificationUri: row.verification_uri,
    verificationUriComplete: row.verification_uri_complete,
    expiresIn: Math.max(0, Math.round((row.expires_at.getTime() - Date.now()) / 1000)),
    interval: row.interval_s,
  };
}

export async function startDeviceFlow(
  kind: AttemptRow['kind'],
  opts: { expectedSub?: string | null; humanHash?: string | null; context?: Record<string, unknown> } = {},
): Promise<AttemptRow> {
  const d = await discovery();
  const body = new URLSearchParams({ client_id: env.WORLD_CLIENT_ID, client_secret: env.WORLD_CLIENT_SECRET, scope: 'openid' });
  const pinSub = Boolean(opts.expectedSub && env.WORLD_SUB_STABLE);
  if (pinSub) body.set('claims', JSON.stringify({ id_token: { sub: { value: opts.expectedSub } } }));
  if (env.WORLD_ACR_VALUES) body.set('acr_values', env.WORLD_ACR_VALUES);

  const res = await fetch(d.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (res.status === 503 || res.status === 429) throw new ApiError('WORLD_UNAVAILABLE', `World returned ${res.status}`);
  const j = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
  };
  if (!res.ok || !j.device_code || !j.user_code || !j.verification_uri) {
    throw new ApiError('UPSTREAM_FAILED', `device_authorization failed: ${j.error ?? res.status}`);
  }
  const id = newId('wa');
  const interval = j.interval ?? 5;
  const [row] = await sql<AttemptRow[]>`
    insert into world_attempts (id, kind, status, device_code_enc, user_code, verification_uri, verification_uri_complete,
                                interval_s, expires_at, next_poll_at, expected_sub, human_hash, context)
    values (${id}, ${kind}, 'PENDING', ${encrypt(j.device_code)}, ${j.user_code}, ${j.verification_uri},
            ${j.verification_uri_complete ?? null}, ${interval},
            now() + make_interval(secs => ${j.expires_in ?? 1200}), now() + make_interval(secs => ${interval}),
            ${pinSub ? opts.expectedSub! : null}, ${opts.humanHash ?? null}, ${sql.json((opts.context ?? {}) as never)})
    returning *`;
  return row!;
}

type PollOutcome = AttemptRow['status'];

/** One poll step for one attempt; persists the outcome. */
export async function pollOnce(row: AttemptRow): Promise<PollOutcome> {
  if (row.expires_at.getTime() < Date.now()) {
    await sql`update world_attempts set status = 'EXPIRED', reason = 'device code expired', updated_at = now() where id = ${row.id}`;
    return 'EXPIRED';
  }
  const d = await discovery();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: env.WORLD_CLIENT_ID,
      client_secret: env.WORLD_CLIENT_SECRET,
      device_code: decrypt(row.device_code_enc),
    }),
  });

  if (res.status === 503) {
    await sql`update world_attempts set next_poll_at = now() + make_interval(secs => ${row.interval_s * 2}), updated_at = now() where id = ${row.id}`;
    return 'PENDING';
  }
  const j = (await res.json()) as { error?: string; id_token?: string };

  if (!res.ok || !j.id_token) {
    switch (j.error) {
      case 'authorization_pending':
        await sql`update world_attempts set next_poll_at = now() + make_interval(secs => ${row.interval_s}), updated_at = now() where id = ${row.id}`;
        return 'PENDING';
      case 'slow_down':
        await sql`update world_attempts set interval_s = interval_s + 5,
                   next_poll_at = now() + make_interval(secs => ${row.interval_s + 5}), updated_at = now() where id = ${row.id}`;
        return 'PENDING';
      case 'access_denied':
        await sql`update world_attempts set status = 'DENIED', reason = 'access_denied', updated_at = now() where id = ${row.id}`;
        return 'DENIED';
      case 'expired_token':
        await sql`update world_attempts set status = 'EXPIRED', reason = 'expired_token', updated_at = now() where id = ${row.id}`;
        return 'EXPIRED';
      default:
        await sql`update world_attempts set status = 'FAILED', reason = ${j.error ?? `http_${res.status}`}, updated_at = now() where id = ${row.id}`;
        return 'FAILED';
    }
  }

  // Validate the ID token in the backend.
  let claims: { iss?: string; sub?: string; auth_time?: number; acr?: string; amr?: unknown };
  try {
    const verified = await jwtVerify(j.id_token, jwks!, { issuer: d.issuer, audience: env.WORLD_CLIENT_ID });
    claims = verified.payload as typeof claims;
  } catch (err) {
    await sql`update world_attempts set status = 'FAILED', reason = ${`invalid_id_token: ${(err as Error).message}`}, updated_at = now() where id = ${row.id}`;
    return 'FAILED';
  }
  const nowS = Date.now() / 1000;
  const startedS = row.started_at.getTime() / 1000;
  let reason: string | null = null;
  if (typeof claims.auth_time !== 'number') reason = 'missing_auth_time';
  else if (claims.auth_time < startedS - 5) reason = 'auth_time_before_attempt';
  else if (nowS - claims.auth_time > env.WORLD_FRESH_SECONDS) reason = 'auth_not_fresh';
  else if (!claims.sub || !claims.iss) reason = 'missing_sub';
  if (reason) {
    await sql`update world_attempts set status = 'FAILED', reason = ${reason}, updated_at = now() where id = ${row.id}`;
    return 'FAILED';
  }
  if (row.expected_sub && claims.sub !== row.expected_sub) {
    await sql`update world_attempts set status = 'DENIED', reason = 'wrong_human', updated_at = now() where id = ${row.id}`;
    return 'DENIED';
  }
  await sql`
    update world_attempts set status = 'APPROVED', result_iss = ${claims.iss!}, result_sub = ${claims.sub!},
           auth_time = ${claims.auth_time!}, acr = ${claims.acr ?? null}, amr = ${sql.json((claims.amr ?? null) as never)},
           updated_at = now()
     where id = ${row.id}`;
  return 'APPROVED';
}

type Handler = (row: AttemptRow) => Promise<void>;
const onApproved = new Map<AttemptRow['kind'], Handler>();
const onFinishedNegative = new Map<AttemptRow['kind'], Handler>();

export function onWorldApproved(kind: AttemptRow['kind'], h: Handler) {
  onApproved.set(kind, h);
}
export function onWorldNotApproved(kind: AttemptRow['kind'], h: Handler) {
  onFinishedNegative.set(kind, h);
}

/** Background worker: polls due attempts and runs the kind-specific handler exactly once. */
export function startWorldWorker(log: { error: (o: object, m: string) => void }) {
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const due = await sql<AttemptRow[]>`select * from world_attempts where status = 'PENDING' and next_poll_at <= now() order by next_poll_at limit 20`;
      for (const row of due) {
        const outcome = await pollOnce(row);
        if (outcome === 'PENDING') continue;
        const [fresh] = await sql<AttemptRow[]>`select * from world_attempts where id = ${row.id}`;
        const handler = outcome === 'APPROVED' ? onApproved.get(row.kind) : onFinishedNegative.get(row.kind);
        if (!handler || !fresh) continue;
        try {
          await handler(fresh);
        } catch (err) {
          log.error({ err, attempt: row.id }, 'world handler failed');
          await sql`update world_attempts set status = 'FAILED', reason = ${`handler: ${(err as Error).message}`}, updated_at = now() where id = ${row.id}`;
        }
      }
    } catch (err) {
      log.error({ err }, 'world worker tick failed');
    } finally {
      busy = false;
    }
  }, 1000);
}
