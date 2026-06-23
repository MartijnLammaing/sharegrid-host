/**
 * Session Manager — the TLS listener for direct LLMUser connections.
 *
 * Responsibilities (Phase 2):
 *  - Hold a binary session slot (one session at a time).
 *  - Accept TLS connections; reject until registered.
 *  - Validate the host key token presented by the LLMUser.
 *  - Enforce 30-minute idle timeout.
 *  - Run the inference loop: accept inference_request messages, forward to
 *    InferenceProxy, stream inference_response_chunk messages back.
 *  - Coordinate session teardown: flush llama.cpp slot, release lock.
 *  - Exit the process on slot-erase failure.
 *
 * See: docs/architecture_llmhost.md §2.2, §4, §5.2
 *      docs/implementation_plan_llmhost.md Phase 2
 */

import { createServer as createTlsServer, type TLSSocket, type Server as TLSServer } from 'node:tls';
import type { Logger } from 'pino';
import {
  PROTOCOL_VERSION,
  type SessionOpenPayload,
  type SessionAck,
  type SessionReject,
  type InferenceRequestPayload,
  type InferenceResponseChunk,
  type SessionClose,
  type SessionTimeout,
  type HostIncomingMessage,
} from '@sharegrid/shared/protocol';
import { verifyEd25519, decodeHostKeyToken } from '@sharegrid/shared/crypto';
import type { InferenceProxy } from './inference-proxy.js';
import type { Config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenState {
  currentToken: string;
  previousToken: string | null;
  /** Epoch ms after which previousToken is no longer valid. */
  previousTokenExpiresAt: number;
  routerPublicKey: string;
  hostId: string;
}

export interface SessionManagerDeps {
  config: Config;
  logger: Logger;
  inferenceProxy: InferenceProxy;
}

export interface SessionManager {
  /** Bind the TLS server to `config.SHAREGRID_LISTEN_PORT`. */
  start(tlsCert: string, tlsKey: string): Promise<void>;
  /** Stop accepting new connections; close gracefully. */
  stop(): Promise<void>;
  /** Called by RouterClient on registration and re-registration. */
  updateTokens(state: TokenState): void;
  /** Set whether new sessions should be accepted. */
  setRegistered(flag: boolean): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB
const PREVIOUS_TOKEN_GRACE_MS = 60_000; // matches router-client schedule

// ─────────────────────────────────────────────────────────────────────────────
// Token validation (pure function — easily unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export function validateToken(
  token: string,
  state: TokenState,
  now: number,
): boolean {
  const { currentToken, previousToken, previousTokenExpiresAt, routerPublicKey, hostId } = state;

  // Decode and verify signature.
  let decoded: ReturnType<typeof decodeHostKeyToken>;
  try {
    decoded = decodeHostKeyToken(token);
  } catch {
    return false;
  }

  const signedBytes = Buffer.from(decoded.payloadB64, 'utf8');
  if (!verifyEd25519(routerPublicKey, signedBytes, decoded.signature)) {
    return false;
  }

  // Host match.
  if (decoded.payload.hostId !== hostId) {
    return false;
  }

  // Freshness: accept current token or previous token within grace window.
  if (token === currentToken) {
    return true;
  }
  if (
    previousToken !== null &&
    token === previousToken &&
    now < previousTokenExpiresAt
  ) {
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { config, logger, inferenceProxy } = deps;
  const log = logger.child({ component: 'session-manager' });

  // ── State ─────────────────────────────────────────────────────────────────
  let server: TLSServer | null = null;
  let registered = false;
  let slotOccupied = false;
  let tokenState: TokenState | null = null;

  // ── Session slot ──────────────────────────────────────────────────────────

  function acquireSlot(): boolean {
    // Synchronous check-and-set — single JS event loop thread guarantees atomicity.
    if (slotOccupied) return false;
    slotOccupied = true;
    return true;
  }

  function releaseSlot(): void {
    slotOccupied = false;
  }

  // ── NDJSON framing ────────────────────────────────────────────────────────

  function writeMessage(sock: TLSSocket, msg: object): void {
    if (!sock.destroyed && sock.writable) {
      sock.write(JSON.stringify(msg) + '\n');
    }
  }

  // ── Session teardown ──────────────────────────────────────────────────────

  /**
   * Coordinate session teardown.
   *
   * If an inference is in progress (inferenceController is set), abort it and
   * wait for the forwardInference promise to settle — forwardInference will
   * call flushSlot internally on abort. Otherwise call flushSlot ourselves.
   * Either way, release the slot and close the socket.
   */
  async function teardown(
    sock: TLSSocket,
    idleTimer: NodeJS.Timeout | null,
    inferenceController: AbortController | null,
    inferencePromise: Promise<void> | null,
  ): Promise<void> {
    if (idleTimer !== null) clearTimeout(idleTimer);

    if (inferenceController !== null) {
      // Abort the in-flight inference. forwardInference calls flushSlot
      // internally on abort — do NOT call it again here.
      inferenceController.abort();
      if (inferencePromise !== null) {
        await inferencePromise;
      }
    } else {
      // No active inference — flush the slot ourselves.
      const erased = await inferenceProxy.flushSlot();
      if (!erased) {
        log.error('slot erase failed after session teardown — exiting');
        process.exit(1);
      }
    }

    releaseSlot();
    log.info('session torn down; slot released');

    if (!sock.destroyed) {
      sock.end();
    }
  }

  // ── Connection handler ────────────────────────────────────────────────────

  function handleConnection(sock: TLSSocket): void {
    // Reject immediately if not yet registered.
    if (!registered) {
      const reject: SessionReject = { v: PROTOCOL_VERSION, type: 'session_reject', reason: 'not_registered' };
      writeMessage(sock, reject);
      sock.end();
      return;
    }

    let buf = '';
    let sessionOpen = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let tornDown = false;

    // Track the active inference turn so teardown can abort it cleanly.
    let inferenceController: AbortController | null = null;
    let inferencePromise: Promise<void> | null = null;

    sock.setEncoding('utf8');

    // ── Idle timer ────────────────────────────────────────────────────────

    function resetIdleTimer(): void {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.info('idle timeout; closing session');
        const msg: SessionTimeout = { v: PROTOCOL_VERSION, type: 'session_timeout' };
        writeMessage(sock, msg);
        void doTeardown();
      }, IDLE_TIMEOUT_MS);
    }

    async function doTeardown(): Promise<void> {
      if (tornDown) return;
      tornDown = true;
      await teardown(sock, idleTimer, inferenceController, inferencePromise);
      idleTimer = null;
      inferenceController = null;
      inferencePromise = null;
    }

    // ── Incoming data ─────────────────────────────────────────────────────

    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_MESSAGE_BYTES) {
        log.warn('message exceeded 1 MiB; closing connection');
        void doTeardown().then(() => sock.destroy());
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;

        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          log.warn('received non-JSON line; closing');
          void doTeardown().then(() => sock.destroy());
          return;
        }

        if (
          typeof raw !== 'object' ||
          raw === null ||
          (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
        ) {
          log.warn('protocol version mismatch; closing');
          void doTeardown().then(() => sock.destroy());
          return;
        }

        void handleMessage(raw as HostIncomingMessage);
      }
    });

    sock.on('error', (err) => {
      log.warn({ err }, 'session socket error');
    });

    sock.on('close', () => {
      if (!tornDown) {
        void doTeardown();
      }
    });

    // ── Message dispatch ──────────────────────────────────────────────────

    async function handleMessage(msg: HostIncomingMessage): Promise<void> {
      switch (msg.type) {
        case 'session_open':
          handleSessionOpen(msg);
          break;
        case 'inference_request':
          await handleInferenceRequest(msg);
          break;
        case 'session_close':
          await handleSessionClose();
          break;
        default:
          msg satisfies never;
      }
    }

    function handleSessionOpen(msg: SessionOpenPayload): void {
      if (sessionOpen) return; // duplicate open — ignore

      // Not registered check (race after initial check).
      if (!registered) {
        const r: SessionReject = { v: PROTOCOL_VERSION, type: 'session_reject', reason: 'not_registered' };
        writeMessage(sock, r);
        sock.end();
        return;
      }

      // Token validation.
      if (tokenState === null || !validateToken(msg.hostKeyToken, tokenState, Date.now())) {
        const r: SessionReject = { v: PROTOCOL_VERSION, type: 'session_reject', reason: 'invalid_token' };
        writeMessage(sock, r);
        sock.end();
        log.info('session rejected: invalid token');
        return;
      }

      // Acquire slot.
      if (!acquireSlot()) {
        const r: SessionReject = { v: PROTOCOL_VERSION, type: 'session_reject', reason: 'busy' };
        writeMessage(sock, r);
        sock.end();
        log.info('session rejected: slot busy');
        return;
      }

      sessionOpen = true;
      resetIdleTimer();

      const ack: SessionAck = { v: PROTOCOL_VERSION, type: 'session_ack' };
      writeMessage(sock, ack);
      log.info('session accepted');
    }

    async function handleInferenceRequest(msg: InferenceRequestPayload): Promise<void> {
      if (!sessionOpen) return;

      // Reset the idle timer so this turn gets a fresh 30-minute window.
      resetIdleTimer();

      // Set up abort control so teardown can cancel mid-turn if the socket closes.
      const controller = new AbortController();
      inferenceController = controller;

      const promise = inferenceProxy.forwardInference(
        msg.body,
        (sseLine: string) => {
          const chunk: InferenceResponseChunk = {
            v: PROTOCOL_VERSION,
            type: 'inference_response_chunk',
            data: sseLine,
          };
          writeMessage(sock, chunk);
        },
        controller.signal,
      );
      inferencePromise = promise;

      await promise;

      // Clear tracking before calling flushSlot so teardown doesn't double-flush
      // if the socket happens to close concurrently at this exact moment.
      inferenceController = null;
      inferencePromise = null;

      // Normal completion (no abort): forwardInference did NOT call flushSlot.
      // Call it ourselves to wipe the KV cache between turns.
      if (!controller.signal.aborted) {
        const erased = await inferenceProxy.flushSlot();
        if (!erased) {
          log.error('slot erase failed after inference turn — exiting');
          process.exit(1);
        }
      }

      log.info('inference turn complete');
      // Session loop continues — wait for next inference_request
    }

    async function handleSessionClose(_msg?: SessionClose): Promise<void> {
      if (!sessionOpen) {
        sock.end();
        return;
      }
      await doTeardown();
    }
  }

  // ── Public interface ──────────────────────────────────────────────────────

  return {
    async start(tlsCert: string, tlsKey: string): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createTlsServer({ cert: tlsCert, key: tlsKey }, handleConnection);
        // Bind the IPv6 wildcard in internet mode so IPv6 sessions are accepted;
        // the IPv4 wildcard otherwise. The advertised endpoint family is governed
        // by the router's mode (see config.ts).
        const bindAddr = config.mode === 'internet' ? '::' : '0.0.0.0';
        server.listen(config.SHAREGRID_LISTEN_PORT, bindAddr, () => {
          log.info({ port: config.SHAREGRID_LISTEN_PORT, bindAddr }, 'session manager listening');
          resolve();
        });
        server.on('error', reject);
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        if (server === null) {
          resolve();
          return;
        }
        // Force-resolve after 3 s so teardown never hangs indefinitely.
        const fallback = setTimeout(() => resolve(), 3_000);
        server.close(() => { clearTimeout(fallback); resolve(); });
      });
    },

    updateTokens(state: TokenState): void {
      // previousTokenExpiresAt: 60 s from now if there is a previousToken.
      tokenState = {
        ...state,
        previousTokenExpiresAt: state.previousToken !== null
          ? Date.now() + PREVIOUS_TOKEN_GRACE_MS
          : 0,
      };
    },

    setRegistered(flag: boolean): void {
      registered = flag;
      log.info({ registered: flag }, 'registered state updated');
    },
  };
}
