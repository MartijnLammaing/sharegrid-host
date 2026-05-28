/**
 * Inference Proxy — thin forwarding layer between Session Manager and llama.cpp.
 *
 * Communicates with llama.cpp via Node.js built-in `http.request` over an
 * internal Unix socket at `/tmp/llama.sock`. The path is fixed inside the
 * container and is not configurable at runtime.
 *
 * Responsibilities:
 *  - Forward prompts via POST /v1/chat/completions (streaming SSE).
 *  - Parse SSE stream and call onChunk / onEnd callbacks.
 *  - Flush the llama.cpp KV cache via DELETE /slots/0 on teardown.
 *
 * See: docs/architecture_llmhost.md §2.3
 *      docs/implementation_plan_llmhost.md Phase 3C
 */

import { request as httpRequest } from 'node:http';
import type { Logger } from 'pino';
import type { ChatMessage } from '@sharegrid/shared/protocol';
import type { Config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface InferenceProxyDeps {
  config: Config;
  logger: Logger;
  /**
   * Override the Unix socket path used to reach llama.cpp.
   * Defaults to `/tmp/llama.sock` (the fixed in-container path).
   * Pass a custom path in integration tests to avoid cross-test conflicts.
   */
  llamaSocketPath?: string;
}

export interface InferenceProxy {
  sendPrompt(
    messages: ChatMessage[],
    onChunk: (content: string) => void,
    onEnd: () => void,
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
  const { config, logger, llamaSocketPath = LLAMA_SOCKET_PATH } = deps;
  const log = logger.child({ component: 'inference-proxy' });

  // ── sendPrompt ────────────────────────────────────────────────────────────

  async function sendPrompt(
    messages: ChatMessage[],
    onChunk: (content: string) => void,
    onEnd: () => void,
  ): Promise<void> {
    const body = JSON.stringify({
      model: config.SHAREGRID_MODEL_NAME,
      messages,
      stream: true,
    });

    return new Promise<void>((resolve) => {
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
          let sseBuffer = '';

          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            sseBuffer += chunk;
            // SSE lines are separated by double newline.
            let boundary: number;
            while ((boundary = sseBuffer.indexOf('\n\n')) !== -1) {
              const block = sseBuffer.slice(0, boundary);
              sseBuffer = sseBuffer.slice(boundary + 2);
              for (const line of block.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') {
                  onEnd();
                  resolve();
                  return;
                }
                try {
                  const parsed = JSON.parse(data) as Record<string, unknown>;
                  const choices = parsed['choices'];
                  if (!Array.isArray(choices) || choices.length === 0) continue;
                  const delta = (choices[0] as Record<string, unknown>)['delta'];
                  if (typeof delta !== 'object' || delta === null) continue;
                  const content = (delta as Record<string, unknown>)['content'];
                  if (typeof content === 'string' && content.length > 0) {
                    onChunk(content);
                  }
                } catch {
                  // Malformed SSE JSON — log and continue.
                  log.debug({ data }, 'failed to parse SSE chunk');
                }
              }
            }
          });

          res.on('end', () => {
            // Stream ended without a [DONE] marker — treat as completion.
            onEnd();
            resolve();
          });

          res.on('error', (err) => {
            log.error({ err }, 'llama.cpp response stream error; treating as completion');
            onEnd();
            resolve();
          });
        },
      );

      req.on('error', (err) => {
        log.error({ err }, 'llama.cpp request error; treating as completion');
        onEnd();
        resolve();
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

  return { sendPrompt, flushSlot };
}
