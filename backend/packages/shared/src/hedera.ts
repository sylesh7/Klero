import { AccountId, Client, PrivateKey, Timestamp, TransactionId } from '@hiero-ledger/sdk';
import { HASHSCAN_BASE } from './constants';

/**
 * Accepts the two formats we use:
 *  - DER hex (portal keys start with 30…; ECDSA DER starts 3030…, ED25519 DER starts 302e…)
 *  - 32-byte ECDSA hex with or without 0x (keys we generate)
 */
export function parsePrivateKey(raw: string): PrivateKey {
  const s = raw.trim();
  const hex = s.startsWith('0x') ? s.slice(2) : s;
  if (/^30[0-9a-fA-F]{60,}$/.test(hex) && hex.length > 64) return PrivateKey.fromStringDer(hex);
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return PrivateKey.fromStringECDSA(hex);
  throw new Error('Unsupported private key format: expected DER hex (30…) or 32-byte ECDSA hex');
}

/** ECDSA private key → "0x" + 64 hex (the format we store and put in .env). */
export function ecdsaKeyToHex(key: PrivateKey): string {
  return `0x${key.toStringRaw()}`;
}

export function clientFor(accountId: string, key: string | PrivateKey): Client {
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(accountId), typeof key === 'string' ? parsePrivateKey(key) : key);
  return client;
}

/** SDK "0.0.X@S.NNNNNNNNN" → Mirror "0.0.X-S-NNNNNNNNN". */
export function toMirrorTxId(sdkTxId: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(sdkTxId);
  if (!m) throw new Error(`Not an SDK transaction id: ${sdkTxId}`);
  return `${m[1]}-${m[2]}-${m[3]!.padStart(9, '0')}`;
}

/** Mirror "0.0.X-S-N" → SDK "0.0.X@S.N". */
export function fromMirrorTxId(mirrorId: string): string {
  const m = /^(\d+\.\d+\.\d+)-(\d+)-(\d+)$/.exec(mirrorId);
  if (!m) throw new Error(`Not a mirror transaction id: ${mirrorId}`);
  return `${m[1]}@${m[2]}.${m[3]!.padStart(9, '0')}`;
}

/** Valid start (unix seconds, integer part) encoded in an SDK tx id. */
export function validStartSecondsOf(sdkTxId: string): number {
  const m = /@(\d+)\./.exec(sdkTxId);
  if (!m) throw new Error(`Not an SDK transaction id: ${sdkTxId}`);
  return Number(m[1]);
}

/** Build a transaction id with an explicit valid start (ms precision is plenty). */
export function txIdWithValidStart(payerAccountId: string, validStartMs: number): TransactionId {
  const seconds = Math.floor(validStartMs / 1000);
  const nanos = (validStartMs % 1000) * 1_000_000;
  return TransactionId.withValidStart(AccountId.fromString(payerAccountId), new Timestamp(seconds, nanos));
}

export const hashscan = {
  tx: (consensusTimestamp: string) => `${HASHSCAN_BASE}/transaction/${consensusTimestamp}`,
  account: (id: string) => `${HASHSCAN_BASE}/account/${id}`,
  token: (id: string) => `${HASHSCAN_BASE}/token/${id}`,
  topic: (id: string) => `${HASHSCAN_BASE}/topic/${id}`,
};

/** Display helper: smallest units → decimal string. */
export function formatUnits(amount: bigint | string, decimals: number): string {
  const v = BigInt(amount);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
