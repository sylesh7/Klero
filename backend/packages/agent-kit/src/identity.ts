import { PrivateKey } from '@hiero-ledger/sdk';
import { privateKeyToAccount } from 'viem/accounts';

/** One secp256k1 key → EVM address (the agent's identity) + Hedera ECDSA key (the agent's Hedera account). */
export function agentIdentity(key: `0x${string}`) {
  const evm = privateKeyToAccount(key);
  const hederaKey = PrivateKey.fromStringECDSA(key.slice(2));
  return { key, address: evm.address.toLowerCase(), publicKeyHex: hederaKey.publicKey.toStringRaw(), hederaKey };
}
