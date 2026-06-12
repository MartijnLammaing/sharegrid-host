/**
 * Router Client — owns the TLS connection to LLMRouter.
 *
 * Responsibilities (Phase 1):
 *  - Generate an ephemeral TLS keypair at startup (in memory only).
 *  - Connect to LLMRouter with TLS fingerprint pinning.
 *  - Register and receive the host key token + router Ed25519 public key.
 *  - Run the heartbeat loop; rotate tokens on each ack.
 *  - Reconnect with exponential backoff on disconnection.
 *
 * See: docs/architecture_llmhost.md §2.1, §5.1
 *      docs/implementation_plan_llmhost.md Phase 3A
 */

import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { TLSSocket } from 'node:tls';
import type { Logger } from 'pino';
import selfsigned from 'selfsigned';
import { computeFingerprint, parseFingerprintFromUrl, connectWithPinnedFingerprint } from '@sharegrid/shared/tls';
import { TlsFingerprintError, RoleKeyMissingError } from '@sharegrid/shared/errors';
import {
  PROTOCOL_VERSION,
  type RegistrationPayload,
  type RegistrationAck,
  type HeartbeatPayload,
  type HeartbeatAck,
} from '@sharegrid/shared/protocol';
import type { Config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisteredInfo {
  hostId: string;
  currentToken: string;
  previousToken: string | null;
  routerPublicKey: string;
}

export interface TokenUpdate {
  currentToken: string;
  previousToken: string | null;
}

export interface RouterClientDeps {
  config: Config;
  logger: Logger;
  modelName: string;
  onRegistered: (info: RegisteredInfo) => void;
  onTokenUpdate: (update: TokenUpdate) => void;
  onDisconnect: () => void;
}

export interface RouterClient {
  /** Starts the connection, registration, and heartbeat loop. Resolves after first registration. */
  start(): Promise<void>;
  /** Cancels all timers and closes the router socket cleanly. */
  stop(): Promise<void>;
  getTlsCert(): string;
  getTlsKey(): string;
  getTlsFingerprint(): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const PREVIOUS_TOKEN_TTL_MS = 60_000;
const IP_DETECT_TIMEOUT_MS = 3_000;

// ─────────────────────────────────────────────────────────────────────────────
// IP auto-detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the host's externally-reachable IP address.
 * IPv6 is preferred over IPv4 to avoid NAT issues.
 * Throws if neither can be detected.
 */
async function detectListenHost(): Promise<string> {
  const tryFetch = async (url: string): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IP_DETECT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return (await res.text()).trim();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // Prefer env var set by start-dev.sh from the host OS — Docker Desktop on
  // macOS does not give containers IPv6 internet access, so api6.ipify.org
  // would silently fail inside the container.
  const envIpv6 = (process.env['SHAREGRID_PUBLIC_IPV6'] ?? '').trim();
  if (envIpv6.length > 0) return envIpv6;

  // Docker: when running inside a container, use the non-loopback IPv4 interface
  // address (the Docker bridge IP) so peers on the same Docker network can reach us.
  // Check this BEFORE api.ipify.org, which would return the public IP and break
  // intra-container communication.
  if (existsSync('/.dockerenv')) {
    const ifaces = networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      if (addrs === undefined) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  }

  const ipv6 = await tryFetch('https://api6.ipify.org');
  if (ipv6 !== null && ipv6.length > 0) return ipv6;

  const ipv4 = await tryFetch('https://api.ipify.org');
  if (ipv4 !== null && ipv4.length > 0) return ipv4;

  throw new Error(
    'could not detect externally-reachable IP address — api.ipify.org failed and no fallback available',
  );
}

export function createRouterClient(deps: RouterClientDeps): RouterClient {
  const { config, logger, modelName, onRegistered, onTokenUpdate, onDisconnect } = deps;
  const log = logger.child({ component: 'router-client' });

  // ── TLS keypair (generated once, held in memory) ──────────────────────────
  const attrs = [{ name: 'commonName', value: 'sharegrid-host' }];
  const pems = selfsigned.generate(attrs, { keySize: 2048, days: 1 });
  const tlsCert = pems.cert;
  const tlsKey = pems.private;
  const tlsFingerprint = computeFingerprint(tlsCert);

  // ── Mutable state ─────────────────────────────────────────────────────────
  let listenHost = '';
  let stopped = false;
  let socket: TLSSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let previousTokenTimer: NodeJS.Timeout | null = null;
  let backoffTimer: NodeJS.Timeout | null = null;
  let hostId = '';
  let currentToken = '';
  let previousToken: string | null = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function clearPreviousTokenTimer(): void {
    if (previousTokenTimer !== null) {
      clearTimeout(previousTokenTimer);
      previousTokenTimer = null;
    }
  }

  function scheduleTokenExpiry(): void {
    clearPreviousTokenTimer();
    previousTokenTimer = setTimeout(() => {
      previousToken = null;
      onTokenUpdate({ currentToken, previousToken: null });
    }, PREVIOUS_TOKEN_TTL_MS);
  }

  /** Write one newline-delimited JSON message to the socket. */
  function sendMessage(sock: TLSSocket, msg: object): void {
    sock.write(JSON.stringify(msg) + '\n');
  }

  // ── NDJSON framing ────────────────────────────────────────────────────────

  /**
   * Read messages from a TLS socket until it closes, calling `onMessage` for
   * each complete newline-delimited JSON object.
   */
  function attachFramer(
    sock: TLSSocket,
    onMessage: (parsed: unknown) => void,
    onClose: () => void,
  ): void {
    const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB
    let buf = '';

    sock.setEncoding('utf8');

    sock.on('data', (chunk: string) => {
      buf += chunk;
      // Defend against oversized messages.
      if (buf.length > MAX_MESSAGE_BYTES) {
        log.warn('incoming message exceeded 1 MiB; closing socket');
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          onMessage(JSON.parse(line));
        } catch {
          log.warn({ line }, 'received non-JSON line from router; ignoring');
        }
      }
    });

    sock.on('close', () => {
      onClose();
    });
    sock.on('error', (err) => {
      log.warn({ err }, 'router socket error');
    });
  }

  // ── Registration flow ─────────────────────────────────────────────────────

  async function connectAndRegister(sock: TLSSocket, roleKey: string): Promise<RegisteredInfo> {
    return new Promise<RegisteredInfo>((resolve, reject) => {
      let resolved = false;

      const onMessage = (raw: unknown): void => {
        if (resolved) return;

        if (
          typeof raw !== 'object' ||
          raw === null ||
          (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
        ) {
          reject(new Error('received message with unexpected protocol version during registration'));
          return;
        }

        const msg = raw as Record<string, unknown>;
        if (msg['type'] !== 'register_ack') {
          reject(new Error(`expected register_ack, got ${String(msg['type'])}`));
          return;
        }

        const ack = msg as unknown as RegistrationAck;
        if (
          typeof ack.hostId !== 'string' ||
          typeof ack.hostKeyToken !== 'string' ||
          typeof ack.routerPublicKey !== 'string'
        ) {
          reject(new Error('malformed register_ack'));
          return;
        }

        resolved = true;
        resolve({
          hostId: ack.hostId,
          currentToken: ack.hostKeyToken,
          previousToken: null,
          routerPublicKey: ack.routerPublicKey,
        });
      };

      const onClose = (): void => {
        if (!resolved) {
          reject(new Error('router socket closed before registration completed'));
        }
      };

      attachFramer(sock, onMessage, onClose);

      const payload: RegistrationPayload = {
        v: PROTOCOL_VERSION,
        type: 'register',
        modelName,
        port: config.SHAREGRID_LISTEN_PORT,
        tlsFingerprint,
        roleKey,
        listenHost,
      };
      sendMessage(sock, payload);
    });
  }

  // ── Heartbeat loop ────────────────────────────────────────────────────────

  function startHeartbeat(sock: TLSSocket): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (sock.destroyed) {
        clearHeartbeat();
        return;
      }
      const hb: HeartbeatPayload = {
        v: PROTOCOL_VERSION,
        type: 'heartbeat',
        hostId,
      };
      sendMessage(sock, hb);
    }, config.SHAREGRID_HEARTBEAT_INTERVAL * 1000);
  }

  function handleHeartbeatAck(ack: HeartbeatAck): void {
    previousToken = currentToken;
    currentToken = ack.hostKeyToken;
    scheduleTokenExpiry();
    onTokenUpdate({ currentToken, previousToken });
    log.debug({ hostId }, 'token rotated on heartbeat ack');
  }

  function handlePostRegistrationMessage(raw: unknown): void {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw as Record<string, unknown>)['v'] !== PROTOCOL_VERSION
    ) {
      log.warn('received message with unexpected protocol version; ignoring');
      return;
    }
    const msg = raw as Record<string, unknown>;
    if (msg['type'] === 'heartbeat_ack') {
      handleHeartbeatAck(msg as unknown as HeartbeatAck);
    } else {
      log.warn({ type: msg['type'] }, 'unexpected message type from router; ignoring');
    }
  }

  // ── Connect lifecycle ─────────────────────────────────────────────────────

  async function connect(): Promise<void> {
    const { host, port, fingerprint, roleKey } = parseFingerprintFromUrl(config.SHAREGRID_ROUTER_URL);

    const sock = await connectWithPinnedFingerprint({ host, port, fingerprint });
    socket = sock;
    log.info({ host, port }, 'connected to router');

    // After registration completes, swap the framer to the post-registration handler.
    const info = await connectAndRegister(sock, roleKey);
    hostId = info.hostId;
    currentToken = info.currentToken;
    previousToken = info.previousToken;

    // Re-attach framer for post-registration messages.
    sock.removeAllListeners('data');
    sock.removeAllListeners('close');
    sock.removeAllListeners('error');

    attachFramer(sock, handlePostRegistrationMessage, () => {
      if (stopped) return;
      clearHeartbeat();
      clearPreviousTokenTimer();
      socket = null;
      log.warn('router connection lost; notifying session manager');
      onDisconnect();
      void reconnectWithBackoff();
    });

    startHeartbeat(sock);

    log.info({ hostId }, 'registered with router');
    onRegistered(info);
  }

  // ── Exponential backoff reconnect ─────────────────────────────────────────

  async function reconnectWithBackoff(): Promise<void> {
    let delay = BACKOFF_INITIAL_MS;
    while (!stopped) {
      log.warn({ delayMs: delay }, 'attempting reconnect to router');
      await new Promise<void>((resolve) => {
        backoffTimer = setTimeout(() => { backoffTimer = null; resolve(); }, delay);
      });
      if (stopped) break;
      try {
        await connect();
        log.info('reconnected and re-registered with router');
        return;
      } catch (err) {
        if (err instanceof TlsFingerprintError) {
          log.error({ err }, 'TLS fingerprint mismatch on reconnect; stopping');
          return;
        }
        if (err instanceof RoleKeyMissingError) {
          log.error({ err }, 'role key missing in router URL; stopping reconnect');
          return;
        }
        log.warn({ err }, 'reconnect attempt failed');
        delay = Math.min(delay * 2, BACKOFF_CAP_MS);
      }
    }
  }

  // ── Public interface ──────────────────────────────────────────────────────

  return {
    getTlsCert: () => tlsCert,
    getTlsKey: () => tlsKey,
    getTlsFingerprint: () => tlsFingerprint,

    async start(): Promise<void> {
      if (config.SHAREGRID_LISTEN_HOST) {
        listenHost = config.SHAREGRID_LISTEN_HOST;
        log.info({ listenHost }, 'using configured listen host');
      } else {
        log.info('detecting externally-reachable IP address...');
        listenHost = await detectListenHost();
        log.info({ listenHost }, 'detected listen host');
      }
      await connect();
    },

    async stop(): Promise<void> {
      stopped = true;
      clearHeartbeat();
      clearPreviousTokenTimer();
      if (backoffTimer !== null) { clearTimeout(backoffTimer); backoffTimer = null; }
      if (socket !== null && !socket.destroyed) {
        await new Promise<void>((resolve) => {
          socket!.end(() => resolve());
          setTimeout(() => {
            socket?.destroy();
            resolve();
          }, 3_000);
        });
        socket = null;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
