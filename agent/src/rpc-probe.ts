import type { Connection } from '@solana/web3.js';

export type RpcProbe = {
  checkedAt: string;
  rpcOk: boolean;
  latencyMs: number | null;
  error: string | null;
};

const PROBE_TTL_MS = 15_000;

/**
 * Asks the RPC for its current slot at most once per 15 seconds and shares the read between callers,
 * so the readiness check costs one call per window however often it is polled.
 */
export function createRpcProbe(connection: Pick<Connection, 'getSlot'>, now: () => number = Date.now): () => Promise<RpcProbe> {
  let cached: { at: number; value: RpcProbe } | null = null;
  let inFlight: Promise<RpcProbe> | null = null;
  return () => {
    if (cached && now() - cached.at < PROBE_TTL_MS) return Promise.resolve(cached.value);
    inFlight ??= (async () => {
      const started = now();
      let value: RpcProbe;
      try {
        await connection.getSlot('confirmed');
        value = { checkedAt: new Date(started).toISOString(), rpcOk: true, latencyMs: now() - started, error: null };
      } catch (err) {
        value = {
          checkedAt: new Date(started).toISOString(),
          rpcOk: false,
          latencyMs: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // A failed read is cached too, so an RPC outage is not hammered by every poll.
      cached = { at: started, value };
      inFlight = null;
      return value;
    })();
    return inFlight;
  };
}
