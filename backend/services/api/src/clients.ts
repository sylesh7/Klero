import { clientFor, directoryFrom, loadDeployments, Mirror, parsePrivateKey, providerAccountsOf, TopicFollower } from '@forkos/shared';
import { env } from './config';

export const operatorKey = parsePrivateKey(env.OPERATOR_KEY);
export const hedera = clientFor(env.OPERATOR_ID, operatorKey);
export const mirror = new Mirror(env.MIRROR_URL);
export const follower = new TopicFollower(mirror, env.HCS_TOPIC_ID);
/** providerId -> registered provider account: only these may announce services (HCS SERVICE). */
export const PROVIDER_ACCOUNT_MAP = providerAccountsOf(loadDeployments().providers);

/** Live service directory, read from the HCS topic (trusted announcements only). */
export async function services() {
  await follower.sync();
  return directoryFrom(follower.messages, PROVIDER_ACCOUNT_MAP);
}
