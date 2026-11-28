import { Connection } from '@solana/web3.js';

const connectionCache = new Map<string, Connection>();

export function getSolanaConnection(rpcUrl: string): Connection {
  let conn = connectionCache.get(rpcUrl);
  if (!conn) {
    conn = new Connection(rpcUrl, 'confirmed');
    connectionCache.set(rpcUrl, conn);
  }
  return conn;
}
