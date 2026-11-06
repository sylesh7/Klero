import { arkivPublic, arkivWallet, clientFor, Mirror, parsePrivateKey, TopicFollower } from '@forkos/shared';
import { env } from './config';

export const operatorKey = parsePrivateKey(env.OPERATOR_KEY);
export const hedera = clientFor(env.OPERATOR_ID, operatorKey);
export const mirror = new Mirror(env.MIRROR_URL);
export const follower = new TopicFollower(mirror, env.HCS_TOPIC_ID);
export const arkivPub = arkivPublic(env.ARKIV_ACCESS_KEY);
export const arkivApi = arkivWallet(env.ARKIV_ACCESS_KEY, env.API_ARKIV_KEY as `0x${string}`);
export const API_ARKIV_ADDRESS = arkivApi.account.address.toLowerCase();
