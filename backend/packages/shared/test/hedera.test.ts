import { describe, expect, it } from 'vitest';
import { formatUnits, fromMirrorTxId, parsePrivateKey, toMirrorTxId, txIdWithValidStart, validStartSecondsOf } from '../src/hedera';

describe('hedera helpers', () => {
  it('converts tx ids both ways', () => {
    expect(toMirrorTxId('0.0.7168602@1793909236.461971198')).toBe('0.0.7168602-1793909236-461971198');
    expect(toMirrorTxId('0.0.5@1700000000.5')).toBe('0.0.5-1700000000-000000005');
    expect(fromMirrorTxId('0.0.5-1700000000-000000005')).toBe('0.0.5@1700000000.000000005');
    expect(validStartSecondsOf('0.0.5@1700000000.000000005')).toBe(1700000000);
  });

  it('builds a tx id with an explicit valid start', () => {
    const id = txIdWithValidStart('0.0.42', 1_700_000_000_123);
    expect(id.toString()).toBe('0.0.42@1700000000.123000000');
  });

  it('parses a generated ECDSA hex key', () => {
    const k = parsePrivateKey('0x' + '11'.repeat(32));
    expect(k.toStringRaw()).toBe('11'.repeat(32));
  });

  it('formats units', () => {
    expect(formatUnits(50000n, 6)).toBe('0.05');
    expect(formatUnits('2000000', 6)).toBe('2');
    expect(formatUnits(0n, 6)).toBe('0');
  });
});
