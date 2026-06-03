/**
 * Shared helpers for host integration tests.
 *
 * Provides:
 *  - MockRouter: a real TLS server that acts as LLMRouter (issues real Ed25519 tokens)
 *  - MockLlamaServer: a real HTTP server on /tmp/llama.sock that acts as llama.cpp
 *  - startHost: wires Router Client + Session Manager + Inference Proxy
 *  - connectUser: opens a TLS connection to the Session Manager
 */

import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { unlinkSync, existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import selfsigned from 'selfsigned';
import { computeFingerprint } from '@sharegrid/shared/tls';
import { signEd25519, encodeHostKeyToken } from '@sharegrid/shared/crypto';
import { PROTOCOL_VERSION, type HostKeyTokenPayload } from '@sharegrid/shared/protocol';
import pino from 'pino';
import { loadConfig } from '../../src/config.js';
import { createComponentLogger } from '../../src/logger.js';
import { createInferenceProxy } from '../../src/inference-proxy.js';
import { createSessionManager, type TokenState } from '../../src/session-manager.js';
import { createRouterClient } from '../../src/router-client.js';

/** Default socket path; use generateLlamaSocketPath() in tests to avoid conflicts. */
export const LLAMA_SOCKET_DEFAULT = '/tmp/llama.sock';

export function generateLlamaSocketPath(): string {
  return `/tmp/llama-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;
}
export const logger = pino({ level: 'silent' });

// ── Port helper ───────────────────────────────────────────────────────────────

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── NDJSON helpers ────────────────────────────────────────────────────────────

export function sendMsg(sock: TLSSocket, msg: object): void {
  sock.write(JSON.stringify(msg) + '\n');
}

/**
 * Attach a persistent NDJSON reader to a socket.
 * Keeps a queue so messages arriving between reads are not lost.
 */
export function createReader(sock: TLSSocket): { read(): Promise<Record<string, unknown>> } {
  const queue: Array<Record<string, unknown>> = [];
  const pending: Array<(msg: Record<string, unknown>) => void> = [];
  let buf = '';

  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (pending.length > 0) {
        pending.shift()!(msg);
      } else {
        queue.push(msg);
      }
    }
  });

  return {
    read(): Promise<Record<string, unknown>> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
}

// ── Mock Router ───────────────────────────────────────────────────────────────

export interface MockRouter {
  port: number;
  fingerprint: string;
  routerPublicKey: string;
  /** Host registration secret — must match the `roleKey` in RegistrationPayload. */
  hostSecret: string;
  /** Issue a token for a given hostId and fingerprint */
  issueToken(hostId: string, tlsFingerprint: string): string;
  stop(): void;
}

export async function startMockRouter(): Promise<MockRouter> {
  // Generate router TLS cert
  const attrs = [{ name: 'commonName', value: 'mock-router' }];
  const pems = selfsigned.generate(attrs, { keySize: 2048, days: 1 });
  const fingerprint = computeFingerprint(pems.cert);

  // Generate Ed25519 signing keypair for host-key tokens
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

  function issueToken(hostId: string, tlsFingerprint: string): string {
    const payload: HostKeyTokenPayload = {
      hostId,
      tlsFingerprint,
      expiresAt: Date.now() + 120_000,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = signEd25519(privateKey, Buffer.from(payloadB64));
    return encodeHostKeyToken(payload, sig);
  }

  // Generate a host secret for role-based access control
  const hostSecret = `mock-host-secret-${Date.now()}`;

  const port = await getFreePort();

  const activeSockets = new Set<TLSSocket>();
  const server = createTlsServer(
    { cert: pems.cert, key: pems.private },
    (sock: TLSSocket) => {
      activeSockets.add(sock);
      sock.once('close', () => activeSockets.delete(sock));
      let buf = '';
      let registeredHostId = '';

      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;

          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg['type'] === 'register') {
            // Validate roleKey — reject if missing or wrong
            if (msg['roleKey'] !== hostSecret) {
              sock.destroy();
              return;
            }
            const hostId = `host-${Date.now()}`;
            registeredHostId = hostId;
            const token = issueToken(hostId, msg['tlsFingerprint'] as string);
            sendMsg(sock, {
              v: PROTOCOL_VERSION,
              type: 'register_ack',
              hostId,
              hostKeyToken: token,
              routerPublicKey: publicKeyPem,
            });
          } else if (msg['type'] === 'heartbeat') {
            const newToken = issueToken(registeredHostId, 'sha256:' + 'a'.repeat(64));
            sendMsg(sock, { v: PROTOCOL_VERSION, type: 'heartbeat_ack', hostKeyToken: newToken });
          }
        }
      });
      sock.on('error', () => { /* suppress */ });
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  return {
    port,
    fingerprint,
    routerPublicKey: publicKeyPem,
    hostSecret,
    issueToken,
    stop() {
      for (const s of activeSockets) s.destroy();
      server.close();
    },
  };
}

// ── Mock llama.cpp HTTP server ────────────────────────────────────────────────

export interface MockLlamaServer {
  /** The Unix socket path this server is listening on */
  socketPath: string;
  /** Control what DELETE /slots/0 returns */
  flushShouldFail: boolean;
  /** Chunks to send for the next POST /v1/chat/completions */
  nextChunks: string[];
  /** Track DELETE /slots/0 calls */
  flushCount: number;
  stop(): void;
}

export async function startMockLlamaServer(socketPath = generateLlamaSocketPath()): Promise<MockLlamaServer & { socketPath: string }> {
  // Clean up any existing socket
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  const state = {
    socketPath,
    flushShouldFail: false,
    nextChunks: ['Hello', ' world'],
    flushCount: 0,
    stop() { server.close(); if (existsSync(socketPath)) { try { unlinkSync(socketPath); } catch { /* ignore */ } } },
  } as MockLlamaServer & { socketPath: string };

  const server = createHttpServer((_req: IncomingMessage, res: ServerResponse) => {
    if (_req.method === 'DELETE' && _req.url === '/slots/0') {
      state.flushCount++;
      res.writeHead(state.flushShouldFail ? 500 : 200);
      res.end();
    } else if (_req.method === 'POST' && _req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const chunk of state.nextChunks) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunk } }] }) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, () => resolve());
    server.on('error', reject);
  });

  return state;
}

// ── Host stack ────────────────────────────────────────────────────────────────

export interface HostStack {
  sessionManagerPort: number;
  hostFingerprint: string;
  /** The token issued at registration that a user can present */
  hostKeyToken(): string;
  stop(): Promise<void>;
}

export async function startHost(mockRouter: MockRouter, llamaSocketPath?: string): Promise<HostStack> {
  const listenPort = await getFreePort();

  const routerUrl = `https://127.0.0.1:${mockRouter.port}?fp=${mockRouter.fingerprint}&key=${mockRouter.hostSecret}`;

  // Set env vars before loadConfig
  process.env['SHAREGRID_ROUTER_URL'] = routerUrl;
  process.env['SHAREGRID_LISTEN_PORT'] = String(listenPort);
  process.env['SHAREGRID_HEARTBEAT_INTERVAL'] = '30';
  process.env['SHAREGRID_MODEL_FILE'] = 'test-model.gguf';
  process.env['SHAREGRID_MODEL_PATH'] = '/tmp/test-model.gguf';

  const config = loadConfig();
  const hostLogger = createComponentLogger('host-integration-test');

  const inferenceProxy = createInferenceProxy({ logger: hostLogger, llamaSocketPath });
  const sessionManager = createSessionManager({ config, logger: hostLogger, inferenceProxy });

  let currentToken = '';
  const modelName = config.SHAREGRID_MODEL_FILE.replace(/\.gguf$/, '');
  const routerClient = createRouterClient({
    config,
    logger: hostLogger,
    modelName,
    onRegistered: (info) => {
      currentToken = info.currentToken;
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
      currentToken = update.currentToken;
    },
    onDisconnect: () => {
      sessionManager.setRegistered(false);
    },
  });

  await sessionManager.start(routerClient.getTlsCert(), routerClient.getTlsKey());
  await routerClient.start();

  const hostFingerprint = routerClient.getTlsFingerprint();

  return {
    sessionManagerPort: listenPort,
    hostFingerprint,
    hostKeyToken: () => currentToken,
    async stop() {
      await routerClient.stop();
      await sessionManager.stop();
    },
  };
}

// ── User TLS client ───────────────────────────────────────────────────────────

export function connectUser(port: number, fingerprint: string): Promise<TLSSocket> {
  const expected = fingerprint.toLowerCase();
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    sock.once('secureConnect', () => {
      const fp = sock.getPeerCertificate().fingerprint256;
      const normalised = 'sha256:' + fp.replace(/:/g, '').toLowerCase();
      if (normalised !== expected) {
        sock.destroy();
        reject(new Error(`fingerprint mismatch`));
        return;
      }
      resolve(sock);
    });
    sock.once('error', reject);
  });
}
