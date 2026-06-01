/**
 * Llama Launcher — spawns the llama-server child process and waits for it to
 * be ready before the rest of the host starts accepting sessions.
 *
 * llama-server listens on a Unix socket at /tmp/llama.sock (fixed path, matches
 * inference-proxy.ts). Readiness is detected by polling for the socket file.
 *
 * If llama-server exits for any reason after startup, the host process also
 * exits so Docker's --restart policy brings it back in a clean state.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { Config } from './config.js';

const LLAMA_BINARY = '/app/llama-server';
const LLAMA_SOCKET_PATH = '/tmp/llama.sock';
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 120_000;

export async function launchLlama(deps: { config: Config; logger: Logger }): Promise<void> {
  const { config, logger } = deps;
  const log = logger.child({ component: 'llama-launcher' });

  const args = [
    '--model', config.SHAREGRID_MODEL_PATH,
    '--host', LLAMA_SOCKET_PATH,
    '--parallel', '1',
    '--ctx-size', '4096',
  ];

  log.info({ model: config.SHAREGRID_MODEL_PATH }, 'spawning llama-server');

  const child = spawn(LLAMA_BINARY, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    log.debug({ output: chunk.toString().trimEnd() }, 'llama-server stdout');
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    log.warn({ output: chunk.toString().trimEnd() }, 'llama-server stderr');
  });

  child.on('error', (err) => {
    log.error({ err }, 'failed to spawn llama-server');
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    log.error({ code, signal }, 'llama-server exited unexpectedly; shutting down host');
    process.exit(1);
  });

  log.info({ socketPath: LLAMA_SOCKET_PATH, timeoutMs: READY_TIMEOUT_MS }, 'waiting for llama-server socket');
  await waitForSocket(LLAMA_SOCKET_PATH, READY_TIMEOUT_MS, READY_POLL_INTERVAL_MS);
  log.info('llama-server is ready');
}

async function waitForSocket(socketPath: string, timeoutMs: number, intervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      await sleep(intervalMs);
    }
  }
  throw new Error(`llama-server did not create socket at ${socketPath} within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
