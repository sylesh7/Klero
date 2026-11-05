import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../src/hash';
import { humanHashOf, intentIdOf, jobKeyOf, memoOf, parseMemo } from '../src/ids';

const SALT = '00'.repeat(32);

describe('ids (ICD-3 vectors)', () => {
  it('humanHash vector', () => {
    expect(humanHashOf('https://auth.world.org', 'sub_test_123', SALT)).toBe(
      'b57fdd6077da84aa6a555e0a9e04b4cc06580bddcb6662645a4b805e52de20eb',
    );
  });

  it('inputHash + jobKey vector', () => {
    const inputHash = `sha256:${sha256Hex('hello forkos')}`;
    expect(inputHash).toBe('sha256:2ea16b944da28393b1e68c9514a99a032b72339c1a4c10893c670a607d1cfc5b');
    const human = humanHashOf('https://auth.world.org', 'sub_test_123', SALT);
    expect(jobKeyOf(human, inputHash)).toBe('11f22571df7398b5c394fd97ead7ca0d0f015d4016fe9bff8903ccf436b656f7');
  });

  it('memo is short and round-trips', () => {
    const job = '11f22571df7398b5c394fd97ead7ca0d0f015d4016fe9bff8903ccf436b656f7';
    expect(memoOf(job, 0)).toBe('forkos:11f22571df7398b5:r0');
    expect(Buffer.byteLength(memoOf(job, 999))).toBeLessThanOrEqual(100);
    expect(parseMemo(memoOf(job, 3))).toEqual({ jobShort: '11f22571df7398b5', round: 3 });
    expect(parseMemo('hello')).toBeNull();
    expect(intentIdOf(job, 2)).toBe('11f22571df7398b5-r2');
  });

  it('canonicalJson sorts keys deeply and stringifies bigint', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }], n: 10n })).toBe('{"a":[{"c":"x","d":2}],"b":1,"n":"10"}');
  });

  it('rejects malformed inputHash', () => {
    expect(() => jobKeyOf('aa', 'md5:abc')).toThrow();
  });
});
