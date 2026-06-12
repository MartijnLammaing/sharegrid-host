/**
 * LLMHost entry point — wires all components together and manages the process lifecycle.
 *
 * Startup sequence (tasks 3D-1, 3D-2):
 *  1. Load and validate configuration.
 *  2. Construct logger.
 *  3. Create InferenceProxy.
 *  4. Create SessionManager.
 *  5. Create RouterClient (callbacks wire the two together).
 *  6. Start SessionManager (bind TLS port).
 *  7. Start RouterClient (connect, register, begin heartbeat loop).
 *  8. Register SIGTERM/SIGINT for graceful shutdown.
 *
 * See: docs/architecture_llmhost.md §3
 *      docs/implementation_plan_llmhost.md Phase 3D
 */

import { basename } from 'node:path';
import { loadConfig } from './config.js';
import { createComponentLogger } from './logger.js';
import { scanModels } from './model-scanner.js';
import { launchLlama } from './llama-launcher.js';
import { createInferenceProxy } from './inference-proxy.js';
import { createSessionManager } from './session-manager.js';
import { createRouterClient } from './router-client.js';
import type { TokenState } from './session-manager.js';

async function main(): Promise<void> {
  // 1. Config — exits on invalid input.
  const config = loadConfig();

  // 2. Logger.
  const logger = createComponentLogger('main');
  logger.info('starting LLMHost');

  // 2b. Discover models and pick the active one.
  const models = await scanModels(config.SHAREGRID_MODELS_DIR);
  if (models.length === 0) {
    logger.error({ dir: config.SHAREGRID_MODELS_DIR }, 'no .gguf models found; cannot start');
    process.exit(1);
  }
  const activeModel = models[0];
  if (!activeModel) {
    logger.error('model selection failed; cannot start');
    process.exit(1);
  }
  logger.info(
    {
      activeModel: activeModel.name,
      modelPath: activeModel.path,
      totalModels: models.length,
    },
    'selected active model from directory scan',
  );

  // 3. Launch llama-server and wait for the Unix socket to be ready.
  await launchLlama({ activeModelPath: activeModel.path, logger });

  const modelName = activeModel.name;

  // 4. Inference proxy.
  const inferenceProxy = createInferenceProxy({ logger });

  // 5. Session manager.
  const sessionManager = createSessionManager({ config, logger, inferenceProxy });

  // Stable registration state — populated on first onRegistered and reused in onTokenUpdate.
  let registrationHostId = '';
  let registrationRouterPublicKey = '';

  // 6. Router client — callbacks link the two components.
  const routerClient = createRouterClient({
    config,
    logger,
    modelName,
    onRegistered: (info) => {
      registrationHostId = info.hostId;
      registrationRouterPublicKey = info.routerPublicKey;

      const state: TokenState = {
        hostId: info.hostId,
        currentToken: info.currentToken,
        previousToken: info.previousToken,
        previousTokenExpiresAt: 0,
        routerPublicKey: info.routerPublicKey,
      };
      sessionManager.updateTokens(state);
      sessionManager.setRegistered(true);
    },
    onTokenUpdate: (update) => {
      const state: TokenState = {
        hostId: registrationHostId,
        routerPublicKey: registrationRouterPublicKey,
        currentToken: update.currentToken,
        previousToken: update.previousToken,
        previousTokenExpiresAt: 0,
      };
      sessionManager.updateTokens(state);
    },
    onDisconnect: () => {
      sessionManager.setRegistered(false);
    },
  });

  // 7. Start session manager (binds port; resolves once listening).
  await sessionManager.start(routerClient.getTlsCert(), routerClient.getTlsKey());
  logger.info({ port: config.SHAREGRID_LISTEN_PORT }, 'session manager started');

  // 8. Register SIGTERM/SIGINT before connecting to the router.
  const DRAIN_TIMEOUT_MS = 10_000;
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal');

    // Stop accepting new sessions immediately.
    sessionManager.setRegistered(false);

    // Give any active session a grace period to drain.
    await sleep(DRAIN_TIMEOUT_MS);

    await routerClient.stop();
    await sessionManager.stop();
    logger.info('graceful shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // 9. Start router client — resolves after first successful registration.
  await routerClient.start();
  logger.info('router registration complete — host is ready');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err: unknown) => {
  console.error('fatal error during startup:', err);
  process.exit(1);
});
