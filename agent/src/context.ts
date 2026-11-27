import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditLog } from './audit.js';
import { createConnection, keypairFromSecret, type Connection, type Keypair } from './chain.js';
import type { AppConfig } from './config.js';
import { loadOrCreateAgentKey } from './crypto.js';
import { createMerchantWorker, type MerchantWorker } from './merchant-worker.js';
import { createRpcProbe, type RpcProbe } from './rpc-probe.js';
import { createModelPipeline, type ModelPipeline } from './model/index.js';
import { SessionManager } from './sessions.js';
import { Store } from './store.js';
import { TelegramService } from './telegram.js';

export type AppContext = {
  config: AppConfig;
  store: Store;
  audit: AuditLog;
  model: ModelPipeline;
  connection: Connection;
  /** The agent signer for this context. Held in memory, never exposed over HTTP. */
  signer: Keypair;
  agentPubkey: string;
  /** Legacy response field; multi-tenant wallet sessions are not pinned. */
  ownerPinned: boolean;
  sessions: SessionManager;
  /** Demo worker/service signer shared by all tenants; stored encrypted in the data dir, never exposed. */
  mockWorker?: Keypair;
  /** The demo merchant as a remote worker, when MERCHANT_WORKER_URL is set. */
  merchantWorker?: MerchantWorker;
  telegram?: TelegramService;
  getUserContext?: (ownerPubkey: string) => AppContext;
  /** Cached RPC liveness read for the readiness check. */
  rpcProbe?: () => Promise<RpcProbe>;
};

/** Where operational warnings go: the Fastify logger in the server, absent in tests. */
export type OpsLogger = { warn(fields: Record<string, unknown>, message: string): void };

// Audit events that mean an action failed. They are mirrored to the operations log with the owner and
// error message only; the full sealed detail stays in the owner's audit file.
const FAILURE_EVENTS = new Set(['tx.failed', 'tx.simulation_failed', 'model.failed']);

function errorOf(detail: unknown): string | undefined {
  if (detail && typeof detail === 'object' && 'error' in detail) {
    const error = (detail as { error: unknown }).error;
    return typeof error === 'string' ? error : JSON.stringify(error);
  }
  return undefined;
}

export function createContext(config: AppConfig, log?: OpsLogger): AppContext {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.usersDir, { recursive: true });

  // Per-deployment key so the demo worker cannot be derived from source.
  const mockWorkerKey = loadOrCreateAgentKey(resolve(config.dataDir, 'mock-worker-keystore.json'), config.AGENT_KEYSTORE_PASSPHRASE);
  const mockWorker = keypairFromSecret(mockWorkerKey.secretKey);

  const connection = createConnection(config.SOLANA_RPC_URL);
  const model = createModelPipeline(config);
  // Persisted so an agent restart (including tsx watch reloads) does not log every owner out.
  const sessions = new SessionManager(
    config.allowedOwners,
    config.AUTH_SESSION_TTL_SECONDS,
    config.adminPubkey,
    resolve(config.dataDir, 'sessions.json'),
  );

  const rpcProbe = createRpcProbe(connection);
  const merchantWorker = config.MERCHANT_WORKER_URL ? createMerchantWorker(config.MERCHANT_WORKER_URL) : undefined;

  const userContexts = new Map<string, AppContext>();
  const telegram = new TelegramService({
    config,
    getUserContext: (ownerPubkey) => getUserContext(ownerPubkey),
    log,
  });

  function getUserContext(ownerPubkey: string): AppContext {
    const cached = userContexts.get(ownerPubkey);
    if (cached) return cached;

    const userDir = resolve(config.usersDir, ownerPubkey);
    mkdirSync(userDir, { recursive: true });

    const userKeystorePath = resolve(userDir, 'agent-keystore.json');
    const userStatePath = resolve(userDir, 'state.json');
    const userAuditPath = resolve(userDir, 'audit.jsonl');
    const userSaltPath = resolve(userDir, 'audit-salt');

    // If this is the admin and legacy state exists, migrate legacy files to admin directory
    const isAdmin = Boolean(config.adminPubkey) && ownerPubkey === config.adminPubkey;
    if (isAdmin) {
      if (!existsSync(userStatePath) && existsSync(config.statePath)) {
        copyFileSync(config.statePath, userStatePath);
      }
      if (!existsSync(userAuditPath) && existsSync(config.auditPath)) {
        copyFileSync(config.auditPath, userAuditPath);
      }
      if (!existsSync(userSaltPath) && existsSync(config.saltPath)) {
        copyFileSync(config.saltPath, userSaltPath);
      }
    }

    const key = loadOrCreateAgentKey(userKeystorePath, config.AGENT_KEYSTORE_PASSPHRASE);
    const audit = new AuditLog(userAuditPath, userSaltPath, config.AUDIT_ENCRYPTION_PASSPHRASE, (event, requestId, detail) => {
      if (log && FAILURE_EVENTS.has(event)) log.warn({ event, requestId, owner: ownerPubkey, error: errorOf(detail) }, event);
    });
    const store = new Store(userStatePath, config.AGENT_ID, config.MAX_REQUESTS_KEPT, ownerPubkey);

    if (key.created) {
      audit.record('agent.keypair_created', null, { publicKey: key.publicKey, owner: ownerPubkey });
    }

    const signer = keypairFromSecret(key.secretKey);
    const userCtx: AppContext = {
      config,
      store,
      audit,
      model,
      connection,
      signer,
      agentPubkey: key.publicKey,
      ownerPinned: false,
      sessions,
      mockWorker,
      merchantWorker,
      telegram,
      getUserContext,
      rpcProbe,
    };

    userContexts.set(ownerPubkey, userCtx);
    return userCtx;
  }

  function createDefaultContext(): AppContext {
    if (config.adminPubkey) return getUserContext(config.adminPubkey);
    const defaultDir = resolve(config.dataDir, '_default');
    mkdirSync(defaultDir, { recursive: true });
    const key = loadOrCreateAgentKey(resolve(defaultDir, 'agent-keystore.json'), config.AGENT_KEYSTORE_PASSPHRASE);
    const audit = new AuditLog(
      resolve(defaultDir, 'audit.jsonl'),
      resolve(defaultDir, 'audit-salt'),
      config.AUDIT_ENCRYPTION_PASSPHRASE,
      (event, requestId, detail) => {
        if (log && FAILURE_EVENTS.has(event)) log.warn({ event, requestId, owner: null, error: errorOf(detail) }, event);
      },
    );
    const store = new Store(resolve(defaultDir, 'state.json'), config.AGENT_ID, config.MAX_REQUESTS_KEPT);
    if (key.created) {
      audit.record('agent.keypair_created', null, { publicKey: key.publicKey, owner: null });
    }
    return {
      config,
      store,
      audit,
      model,
      connection,
      signer: keypairFromSecret(key.secretKey),
      agentPubkey: key.publicKey,
      ownerPinned: false,
      sessions,
      mockWorker,
      merchantWorker,
      telegram,
      getUserContext,
      rpcProbe,
    };
  }

  const defaultUserCtx = createDefaultContext();

  return {
    ...defaultUserCtx,
    config,
    sessions,
    telegram,
    getUserContext,
    rpcProbe,
  };
}
