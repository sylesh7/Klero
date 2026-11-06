import { arkivPublic, arkivWallet } from '@forkos/shared';
import { env } from './config';

export const arkivPub = arkivPublic(env.ARKIV_ACCESS_KEY);
export const arkivProviderWallet = arkivWallet(env.ARKIV_ACCESS_KEY, env.PROVIDER_ARKIV_KEY as `0x${string}`);
