import { z } from 'zod';

export const zHederaId = z.string().regex(/^0\.0\.\d+$/, 'expected a Hedera id like 0.0.1234');
export const zHex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars');
export const zEvmAddr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected an EVM address')
  .transform((s) => s.toLowerCase());
export const zPrivHex = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x + 64 hex chars');
export const zIntString = z.string().regex(/^\d+$/, 'expected a non-negative integer string');

/**
 * Validates process.env against a zod shape and returns typed values.
 * Throws one readable error listing every problem (fail fast at boot).
 */
export function loadEnv<T extends z.ZodRawShape>(shape: T): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Railway injects PORT; locally we use the service-specific variable. */
export function portFrom(fallbackVar: string, fallback: number): number {
  const raw = process.env.PORT ?? process.env[fallbackVar];
  const n = raw ? Number(raw) : fallback;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid port in PORT/${fallbackVar}: ${raw}`);
  return n;
}
