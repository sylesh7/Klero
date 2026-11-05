import { CAPABILITY } from './constants';
import { canonicalJson, sha256Hex } from './hash';

export function inputHashOf(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

export function humanHashOf(iss: string, sub: string, salt: string): string {
  return sha256Hex(`forkos:human:v1|${iss}|${sub}|${salt}`);
}

export function jobKeyOf(humanHash: string, inputHash: string, capability: string = CAPABILITY): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(inputHash)) throw new Error(`bad inputHash: ${inputHash}`);
  return sha256Hex(`forkos:job:v1|${humanHash}|${capability}|${inputHash}`);
}

export function jobShort(jobKey: string): string {
  return jobKey.slice(0, 16);
}

export function intentIdOf(jobKey: string, round: number): string {
  return `${jobShort(jobKey)}-r${round}`;
}

export function memoOf(jobKey: string, round: number): string {
  return `forkos:${jobShort(jobKey)}:r${round}`;
}

/** Parses a memo written by memoOf; returns null for anything else. */
export function parseMemo(memo: string): { jobShort: string; round: number } | null {
  const m = /^forkos:([0-9a-f]{16}):r(\d+)$/.exec(memo);
  return m ? { jobShort: m[1]!, round: Number(m[2]) } : null;
}

export function digestOf(action: unknown): string {
  return sha256Hex(canonicalJson(action));
}
