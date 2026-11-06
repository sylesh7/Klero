import { TopicCreateTransaction } from '@hiero-ledger/sdk';
import { clientFor } from '../packages/shared/src/hedera';
import { publishHcs, readTopic, waitForSeq } from '../packages/shared/src/hcs';
import { Mirror } from '../packages/shared/src/mirror';

const client = clientFor(process.env.OPERATOR_ID!, process.env.OPERATOR_KEY!);
const mirror = new Mirror(process.env.MIRROR_URL);
const topicId = (await (await new TopicCreateTransaction().setTopicMemo('forkos smoke').execute(client)).getReceipt(client)).topicId!.toString();
console.log('throwaway topic', topicId);

const t0 = Date.now();
const { seq } = await publishHcs(client, topicId, { v: 1, t: 'APPROVAL', human: 'e'.repeat(64), kind: 'LINK', digest: 'f'.repeat(64) });
console.log('published seq', seq, 'receipt after', Date.now() - t0, 'ms');
await waitForSeq(mirror, topicId, seq);
console.log('visible on mirror after', Date.now() - t0, 'ms');
const msgs = await readTopic(mirror, topicId);
console.log('decoded:', msgs.map((m) => ({ seq: m.seq, payer: m.payer, t: m.msg?.t })));
client.close();
