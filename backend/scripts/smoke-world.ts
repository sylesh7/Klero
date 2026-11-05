// Proves: discovery is reachable, the device endpoint exists, and our client credentials are accepted.
// Usage: pnpm smoke:world            → starts a device authorization and prints the user code
//        pnpm smoke:world poll <device_code>
export {};
const issuer = process.env.WORLD_ISSUER;
const clientId = process.env.WORLD_CLIENT_ID;
const clientSecret = process.env.WORLD_CLIENT_SECRET;
if (!issuer || !clientId || !clientSecret) throw new Error('Set WORLD_ISSUER, WORLD_CLIENT_ID, WORLD_CLIENT_SECRET');

const disco = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
console.log('issuer:', disco.issuer);
console.log('device_authorization_endpoint:', disco.device_authorization_endpoint);
console.log('token_endpoint:', disco.token_endpoint);
console.log('jwks_uri:', disco.jwks_uri);
console.log('grant_types_supported:', disco.grant_types_supported);

if (process.argv[2] === 'poll') {
  const deviceCode = process.argv[3];
  if (!deviceCode) throw new Error('usage: pnpm smoke:world poll <device_code>');
  const res = await fetch(String(disco.token_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  console.log(res.status, body.error ?? 'tokens received');
  if (typeof body.id_token === 'string') {
    const payload = JSON.parse(Buffer.from(body.id_token.split('.')[1]!, 'base64url').toString());
    // Only for this smoke test: print claim NAMES and the sub prefix, never the token itself.
    console.log('claims:', Object.keys(payload).join(','), 'sub prefix:', String(payload.sub).slice(0, 8));
  }
} else {
  const res = await fetch(String(disco.device_authorization_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'openid' }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`device_authorization failed ${res.status}: ${JSON.stringify(body)}`);
  console.log('user_code:', body.user_code);
  console.log('verification_uri_complete:', body.verification_uri_complete);
  console.log('expires_in:', body.expires_in, 'interval:', body.interval);
  console.log(`\nApprove it on your phone, then run:\n  pnpm smoke:world poll ${String(body.device_code)}`);
}
