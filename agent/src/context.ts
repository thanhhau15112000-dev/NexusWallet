import { AuditLog } from './audit.js';
import { createConnection, keypairFromSecret, type Connection, type Keypair } from './chain.js';
import type { AppConfig } from './config.js';
import { loadOrCreateAgentKey } from './crypto.js';
import { createModelPipeline, type ModelPipeline } from './model/index.js';
import { Store } from './store.js';

export type AppContext = {
  config: AppConfig;
  store: Store;
  audit: AuditLog;
  model: ModelPipeline;
  connection: Connection;
  /** The only signer in the system. Held in memory, never exposed over HTTP. */
  signer: Keypair;
  agentPubkey: string;
  /** True when OWNER_PUBKEY pins the owner, so /api/owner cannot rebind it. */
  ownerPinned: boolean;
};

export function createContext(config: AppConfig): AppContext {
  const key = loadOrCreateAgentKey(config.keystorePath, config.AGENT_KEYSTORE_PASSPHRASE);
  const audit = new AuditLog(config.auditPath, config.saltPath, config.AUDIT_ENCRYPTION_PASSPHRASE);
  const store = new Store(config.statePath, config.AGENT_ID, config.MAX_REQUESTS_KEPT);

  if (config.OWNER_PUBKEY) store.setOwner(config.OWNER_PUBKEY);
  if (key.created) audit.record('agent.keypair_created', null, { publicKey: key.publicKey });

  return {
    config,
    store,
    audit,
    model: createModelPipeline(config),
    connection: createConnection(config.SOLANA_RPC_URL),
    signer: keypairFromSecret(key.secretKey),
    agentPubkey: key.publicKey,
    ownerPinned: config.OWNER_PUBKEY.length > 0,
  };
}
