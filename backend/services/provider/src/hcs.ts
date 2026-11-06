import { Mirror, TopicFollower } from '@forkos/shared';
import { env } from './config';

export const mirror = new Mirror(env.MIRROR_URL);
export const follower = new TopicFollower(mirror, env.HCS_TOPIC_ID);
