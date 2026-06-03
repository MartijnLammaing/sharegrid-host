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
 *  - On abort: destroy the in-flight request and flush the llama.cpp KV cache.
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
   * `onChunk`. Resolves when `data: [DONE]` is received, the response stream
   * ends, or `signal` is aborted. On abort, calls `flushSlot()` before
   * returning so the KV cache is cleared even though the session manager does
   * not get a chance to call it.
   *
   * Never rejects — all errors are logged and the promise resolves.
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
    body: string,
    onChunk: (sseLine: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;

      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      // ── Abort handling ──────────────────────────────────────────────────

      const onAbort = (): void => {
        req.destroy();
        // flushSlot so the KV cache is cleared even though the Session Manager
        // won't call it (the socket close interrupts normal teardown flow).
        void flushSlot().then(finish);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };

      // ── HTTP request ────────────────────────────────────────────────────

      const req = httpRequest(
        {
          socketPath: llamaSocketPath,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let buf = '';

          res.setEncoding('utf8');

          res.on('data', (chunk: string) => {
            if (signal.aborted) return;

            buf += chunk;

            // Split on newlines; emit each non-empty, non-blank line.
            let nl: number;
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl).trimEnd();
              buf = buf.slice(nl + 1);

              if (line.length === 0) continue; // skip blank SSE separators

              onChunk(line);

              if (line === 'data: [DONE]') {
                cleanup();
                res.destroy();
                finish();
                return;
              }
            }
          });

          res.on('end', () => {
            cleanup();
            finish();
          });

          res.on('error', (err) => {
            cleanup();
            if (!signal.aborted) {
              log.error({ err }, 'llama.cpp response stream error');
            }
            finish();
          });
        },
      );

      req.on('error', (err) => {
        cleanup();
        if (!signal.aborted) {
          log.error({ err }, 'llama.cpp request error');
        }
        finish();
      });

      req.write(body);
      req.end();
    });
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
