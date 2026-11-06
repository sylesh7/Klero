import { VOID_MARGIN_S, type Mirror } from '@forkos/shared';

export type IntentState =
  | { state: 'PAID'; consensusTimestamp: string }
  | { state: 'FAILED'; result: string; consensusTimestamp: string } // reached consensus, money did not move
  | { state: 'VOID'; provedAtS: number } // can never execute
  | { state: 'UNKNOWN'; retryAfterMs: number };

/**
 * The death-clock rule (I.3). Never re-sign while UNKNOWN; resend the same bytes or wait.
 * `mirror` only needs getTransaction, so tests can pass a fake.
 */
export async function resolveIntent(
  mirror: Pick<Mirror, 'getTransaction'>,
  txId: string,
  deadlineS: number,
  nowMs = Date.now(),
): Promise<IntentState> {
  const found = await mirror.getTransaction(txId);
  if (found.found) {
    return found.success
      ? { state: 'PAID', consensusTimestamp: found.consensusTimestamp }
      : { state: 'FAILED', result: found.result, consensusTimestamp: found.consensusTimestamp };
  }
  const nowS = nowMs / 1000;
  const voidAt = deadlineS + VOID_MARGIN_S;
  if (nowS > voidAt) return { state: 'VOID', provedAtS: Math.floor(nowS) };
  const untilVoidMs = Math.max(1000, Math.ceil((voidAt - nowS) * 1000));
  return { state: 'UNKNOWN', retryAfterMs: Math.min(5000, untilVoidMs) };
}
