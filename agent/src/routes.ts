import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerRequestRoutes } from './routes/requests.js';
import { registerTaskVaultRoutes } from './routes/task-vault.js';
import { registerWalletRoutes } from './routes/wallet.js';

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  registerMcpRoutes(app, ctx);
  registerActionRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerNotificationRoutes(app, ctx);
  registerWalletRoutes(app, ctx);
  registerRequestRoutes(app, ctx);
  registerTaskVaultRoutes(app, ctx);
}
