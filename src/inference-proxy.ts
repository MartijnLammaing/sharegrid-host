/**
 * Inference Proxy — raw forwarding layer between Session Manager and llama.cpp.
 *
 * Phase 2: forwards the full OpenAI request body verbatim to llama.cpp and
 * streams raw SSE lines back. No content parsing; no text extraction.
 *
 * Communicates with llama.cpp via Node.js built-in `http.request` over an
 * internal Unix socket at `/tmp/llama.sock`. The path is fixed inside the
 * container and is not configurable at runtime.
 *
 * Responsibilities:
 *  - POST the raw OpenAI request body to /v1/chat/completions (streaming SSE).
 *  - Emit each raw SSE line to the caller via onChunk.
 *  - Flush the llama.cpp KV cache via DELETE /slots/0 on teardown.
 *
 * See: docs/architecture_llmhost.md §2.3
 *      docs/implementation_plan_llmhost.md Phase 1
 */

import { request as httpRequest } from 'node:http';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface InferenceProxyDeps {
  logger: Logger;
  /**
   * Override the Unix socket path used to reach llama.cpp.
   * Defaults to `/tmp/llama.sock` (the fixed in-container path).
   * Pass a custom path in integration tests to avoid cross-test conflicts.
   */
  llamaSocketPath?: string;
}

export interface InferenceProxy {
  /**
   * POST the raw OpenAI `body` to llama.cpp and stream raw SSE lines back.
   *
   * Each SSE line (e.g. `"data: {...}"` or `"data: [DONE]"`) is emitted via
   * `onChunk`. Resolves when `data: [DONE]` is received or the request is
   * aborted via `signal`. On abort, calls `flushSlot()` before returning.
   *
   * Implemented in Phase 2 host task 1-1.
   */
  forwardInference(
    body: string,
    onChunk: (sseLine: string) => void,
    signal: AbortSignal,
  ): Promise<void>;

  /** Returns true on HTTP 2xx, false on any error or non-2xx status. */
  flushSlot(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LLAMA_SOCKET_PATH = '/tmp/llama.sock';
const FLUSH_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createInferenceProxy(deps: InferenceProxyDeps): InferenceProxy {
  const { logger, llamaSocketPath = LLAMA_SOCKET_PATH } = deps;
  const log = logger.child({ component: 'inference-proxy' });

  // ── forwardInference ──────────────────────────────────────────────────────

  async function forwardInference(
    _body: string,
    _onChunk: (sseLine: string) => void,
    _signal: AbortSignal,
  ): Promise<void> {
    throw new Error('not implemented');
  }

  // ── flushSlot ─────────────────────────────────────────────────────────────

  async function flushSlot(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        req.destroy();
        log.error('llama.cpp DELETE /slots/0 timed out');
        resolve(false);
      }, FLUSH_TIMEOUT_MS);

      const req = httpRequest(
        {
          socketPath: llamaSocketPath,
          path: '/slots/0',
          method: 'DELETE',
        },
        (res) => {
          // Drain the response body so the socket can be reused.
          res.resume();
          res.on('end', () => {
            clearTimeout(timer);
            const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
            if (!ok) {
              log.error({ statusCode: res.statusCode }, 'llama.cpp slot erase returned non-2xx');
            }
            resolve(ok);
          });
          res.on('error', (err) => {
            clearTimeout(timer);
            log.error({ err }, 'llama.cpp slot erase response error');
            resolve(false);
          });
        },
      );

      req.on('error', (err) => {
        clearTimeout(timer);
        log.error({ err }, 'llama.cpp slot erase request error');
        resolve(false);
      });

      req.end();
    });
  }

  return { forwardInference, flushSlot };
}
