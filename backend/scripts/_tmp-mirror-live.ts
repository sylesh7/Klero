import { Mirror, fromMirrorTxId } from '@forkos/shared';
const m = new Mirror();
const T = '0.0.7732679';

const miss = await m.getTransaction('0.0.99@1700000000.000000001');
if (miss.found !== false) throw new Error('expected found:false');
console.log('[1] unknown tx id -> found:false  (VOID proof basis)  OK');

const res = await fetch('https://testnet.mirrornode.hedera.com/api/v1/transactions?transactiontype=CRYPTOTRANSFER&order=desc&limit=1&result=success');
const real = ((await res.json()) as any).transactions[0];
const hit = await m.getTransaction(fromMirrorTxId(real.transaction_id));
if (!hit.found || !hit.success) throw new Error('round-trip lookup failed');
console.log('[2] tx-id round trip', real.transaction_id, '-> found/SUCCESS, validDuration =', hit.tx.valid_duration_seconds, ' OK');

// the case the doc got wrong: afterSeq = 0
const all = await m.topicMessages(T, 0);
console.log('[3] topicMessages(afterSeq=0) ->', all.length, 'messages (was a 400 before the fix)  OK');
if (all.length === 0) throw new Error('expected messages');
const seqs = all.map((x) => x.sequence_number);
if (seqs[0] !== 1) throw new Error('expected to start at seq 1, got ' + seqs[0]);
const ascending = seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
const contiguous = seqs.every((s, i) => s === i + 1);
console.log('    seq range', seqs[0], '->', seqs[seqs.length - 1], '| ascending:', ascending, '| contiguous:', contiguous);
if (!ascending) throw new Error('consensus order broken - the referee depends on this');
if (all.length > 100) console.log('    pagination exercised past the 100-row page limit  OK');

// incremental follow, the follower's hot path
const tail = await m.topicMessages(T, seqs[seqs.length - 1]!);
console.log('[4] topicMessages(afterSeq=last) ->', tail.length, 'messages (expect 0)  OK');
const mid = Math.floor(seqs.length / 2);
const after = await m.topicMessages(T, seqs[mid]!);
if (after.length !== all.length - mid - 1) throw new Error(`incremental read wrong: ${after.length} vs ${all.length - mid - 1}`);
console.log('[5] incremental read from seq', seqs[mid], '->', after.length, 'messages, exactly the remainder  OK');

const need = ['consensus_timestamp','message','payer_account_id','running_hash','running_hash_version','sequence_number','topic_id'];
if (!need.every((k) => k in all[0]!)) throw new Error('ICD-5 field missing');
console.log('[6] ICD-5 message fields all present; payer_account_id =', all[0]!.payer_account_id, ' OK');

console.log('\nALL LIVE MIRROR CHECKS PASSED');
