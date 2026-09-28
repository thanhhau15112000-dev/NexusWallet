import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuditLog } from './audit.js';
import { createConnection, keypairFromSecret, type Connection, type Keypair } from './chain.js';
import type { AppConfig } from './config.js';
import { loadOrCreateAgentKey } from './crypto.js';
import { loadOrCreateMasterFunder } from './funder.js';
import { createModelPipeline, type ModelPipeline } from './model/index.js';
import { SessionManager } from './sessions.js';
import { Store } from './store.js';

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
  masterFunder?: Keypair;
  masterFunderPubkey?: string;
  /** Demo worker/service signer shared by all tenants; stored encrypted in the data dir, never exposed. */
  mockWorker?: Keypair;
  getUserContext?: (ownerPubkey: string) => AppContext;
};

export function createContext(config: AppConfig): AppContext {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.usersDir, { recursive: true });

  const funder = loadOrCreateMasterFunder({
    masterFunderPath: config.masterFunderPath,
    legacyKeystorePath: config.legacyKeystorePath,
    passphrase: config.AGENT_KEYSTORE_PASSPHRASE,
  });

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

  const userContexts = new Map<string, AppContext>();

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
    const isAdmin = ownerPubkey === config.adminPubkey;
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
    const audit = new AuditLog(userAuditPath, userSaltPath, config.AUDIT_ENCRYPTION_PASSPHRASE);
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
      masterFunder: funder.keypair,
      masterFunderPubkey: funder.pubkey,
      mockWorker,
      getUserContext,
    };

    userContexts.set(ownerPubkey, userCtx);
    return userCtx;
  }

  const defaultOwner = config.adminPubkey;
  const defaultUserCtx = getUserContext(defaultOwner);

  return {
    ...defaultUserCtx,
    config,
    sessions,
    masterFunder: funder.keypair,
    masterFunderPubkey: funder.pubkey,
    getUserContext,
  };
}
