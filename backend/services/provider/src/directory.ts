import { CAPABILITY, clientFor, directoryFrom, publishHcs } from '@forkos/shared';
import { ENDPOINT, env, PROVIDER_ACCOUNT_MAP } from './config';
import { follower } from './hcs';

const client = clientFor(env.PROVIDER_ACCOUNT_ID, env.PROVIDER_ACCOUNT_KEY);

/** HCS sequence number of our live SERVICE announcement (null until published / seen). */
export let serviceSeq: number | null = null;

/**
 * Announce this provider in the HCS service directory. Submitted by our own account, so readers can trust it
 * (directoryFrom accepts only the registered provider account as payer and payTo). Skipped when the latest
 * announcement on the topic already says exactly this — restarts don't spam the topic.
 */
export async function publishService(): Promise<number> {
  await follower.sync();
  const mine = directoryFrom(follower.messages, PROVIDER_ACCOUNT_MAP).find((s) => s.providerId === env.PROVIDER_ID);
  if (
    mine &&
    mine.price === BigInt(env.PROVIDER_PRICE) &&
    mine.endpoint === ENDPOINT &&
    mine.name === env.PROVIDER_NAME &&
    mine.asset === env.PAY_ASSET
  ) {
    serviceSeq = mine.seq;
    return mine.seq;
  }
  const { seq } = await publishHcs(client, env.HCS_TOPIC_ID, {
    v: 1,
    t: 'SERVICE',
    svc: env.PROVIDER_ID,
    cap: CAPABILITY,
    name: env.PROVIDER_NAME,
    price: env.PROVIDER_PRICE,
    asset: env.PAY_ASSET,
    payTo: env.PROVIDER_ACCOUNT_ID,
    url: ENDPOINT,
  });
  serviceSeq = seq;
  return seq;
}

export function startDirectoryRefresh(log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  void publishService()
    .then((seq) => log.info({ seq }, 'service announced on HCS'))
    .catch((err) => log.error({ err }, 'HCS service announcement failed'));
}
