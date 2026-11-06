import { CAPABILITY, ExpirationTime, NETWORK, ServiceSchema, listServices, u64 } from '@forkos/shared';
import { ENDPOINT, env } from './config';
import { arkivProviderWallet, arkivPub } from './arkiv';

export let serviceKey: string | null = null;

/** Create or refresh our Service entity (owner = provider wallet). Lifetime 24 h, refreshed every 6 h. */
export async function publishService(): Promise<string> {
  const owner = arkivProviderWallet.account.address.toLowerCase();
  const values = {
    providerId: env.PROVIDER_ID,
    capability: CAPABILITY,
    network: NETWORK,
    asset: env.PAY_ASSET,
    price: u64(BigInt(env.PROVIDER_PRICE)),
    name: env.PROVIDER_NAME,
    endpoint: ENDPOINT,
    payTo: env.PROVIDER_ACCOUNT_ID,
  };
  const existing = (await listServices(arkivPub)).find((s) => s.providerId === env.PROVIDER_ID && s.owner === owner);
  if (existing) {
    const key = existing.key as `0x${string}`;
    await arkivProviderWallet.patchEntity(ServiceSchema, key, { set: values });
    await arkivProviderWallet.extendEntity({
      entityKey: key,
      expiration: ExpirationTime.atDate(new Date(Date.now() + 24 * 3600_000)),
    });
    serviceKey = existing.key;
    return existing.key;
  }
  const created = await arkivProviderWallet.createEntity(ServiceSchema, values, {
    expiration: ExpirationTime.fromHours(24),
  });
  serviceKey = created.entityKey;
  return created.entityKey;
}

export function startDirectoryRefresh(log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  const run = async () => {
    try {
      const key = await publishService();
      log.info({ key }, 'arkiv service published');
    } catch (err) {
      log.error({ err }, 'arkiv service publish failed');
    }
  };
  void run();
  setInterval(run, 6 * 3600_000);
}
