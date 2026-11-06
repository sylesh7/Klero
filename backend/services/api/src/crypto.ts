import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './config';

const KEY = Buffer.from(env.KEY_ENCRYPTION_SECRET, 'hex');

/** AES-256-GCM. Output: iv.tag.ciphertext (base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !enc) throw new Error('bad sealed value');
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

export function newToken(prefix: 'fos' | 'fat'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

/** Tokens are stored only as peppered hashes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(env.SESSION_SECRET).update(token).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}
