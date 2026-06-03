import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signEd25519, encodeHostKeyToken } from '@sharegrid/shared/crypto';
import { PROTOCOL_VERSION } from '@sharegrid/shared/protocol';
import type { HostKeyTokenPayload } from '@sharegrid/shared/protocol';
import pino from 'pino';
import { validateToken, type TokenState } from '../../src/session-manager.js';
import type { MockInstance } from '@vitest/spy';

// ── Mock node:tls ─────────────────────────────────────────────────────────────
let capturedConnectionCallback: ((sock: MockTLSSocket) => void) | null = null;

vi.mock('node:tls', () => ({
  createServer: vi.fn(
    (_opts: unknown, callback: (sock: MockTLSSocket) => void) => {
      capturedConnectionCallback = callback;
      return {
        listen: vi.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); }),
        close: vi.fn((cb?: () => void) => { cb?.(); }),
        on: vi.fn(),
      };
    },
  ),
}));

import { createSessionManager } from '../../src/session-manager.js';

// ── Mock TLS socket ──────────────────────────────────────────────────────────

class MockTLSSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  writable = true;

  setEncoding(_enc: string) { return this; }
  write(data: string) { this.written.push(data); return true; }
  end() { this.destroyed = true; return this; }
  destroy() { this.destroyed = true; return this; }
  override removeAllListeners(event?: string) { super.removeAllListeners(event); return this; }

  inject(msg: object) { this.emit('data', JSON.stringify(msg) + '\n'); }
  close() { this.emit('close'); }

  lastMessage(): Record<string, unknown> {
    const last = this.written[this.written.length - 1];
    return JSON.parse(last!.trim()) as Record<string, unknown>;
  }
}

// ── Helpers for real crypto ───────────────────────────────────────────────────

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

function makeToken(
  hostId: string,
  privateKey: Parameters<typeof signEd25519>[0],
  overrides: Partial<HostKeyTokenPayload> = {},
): string {
  const payload: HostKeyTokenPayload = {
    hostId,
    tlsFingerprint: 'sha256:' + 'a'.repeat(64),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = signEd25519(privateKey, Buffer.from(payloadB64));
  return encodeHostKeyToken(payload, sig);
}

const logger = pino({ level: 'silent' });
const config = {
  SHAREGRID_ROUTER_URL: 'https://x:1?fp=sha256:' + 'a'.repeat(64),
  SHAREGRID_LISTEN_PORT: 9000,
  SHAREGRID_HEARTBEAT_INTERVAL: 30,
  SHAREGRID_MODEL_FILE: 'test-model.gguf',
  SHAREGRID_MODEL_PATH: '/data/model.gguf',
};

const mockInferenceProxy = {
  forwardInference: vi.fn().mockResolvedValue(undefined),
  flushSlot: vi.fn().mockResolvedValue(true),
};

function makeManager() {
  return createSessionManager({ config, logger, inferenceProxy: mockInferenceProxy });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5-2: validateToken (pure function)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateToken (pure)', () => {
  const { privateKey, publicKeyPem } = makeKeyPair();
  const hostId = 'host-1';

  function makeState(overrides: Partial<TokenState> = {}): TokenState {
    const currentToken = makeToken(hostId, privateKey);
    return {
      hostId,
      routerPublicKey: publicKeyPem,
      currentToken,
      previousToken: null,
      previousTokenExpiresAt: 0,
      ...overrides,
    };
  }

  it('accepts a valid current token', () => {
    const state = makeState();
    expect(validateToken(state.currentToken, state, Date.now())).toBe(true);
  });

  it('accepts a valid previous token within the 60s grace window', () => {
    const previousToken = makeToken(hostId, privateKey);
    const currentToken = makeToken(hostId, privateKey);
    const state = makeState({
      currentToken,
      previousToken,
      previousTokenExpiresAt: Date.now() + 30_000,
    });
    expect(validateToken(previousToken, state, Date.now())).toBe(true);
  });

  it('rejects a previous token past its expiry', () => {
    // Use distinct expiresAt values so the tokens are never identical
    // even when generated in the same millisecond.
    const previousToken = makeToken(hostId, privateKey, { expiresAt: Date.now() + 30_000 });
    const currentToken = makeToken(hostId, privateKey, { expiresAt: Date.now() + 60_000 });
    const state = makeState({
      currentToken,
      previousToken,
      previousTokenExpiresAt: Date.now() - 1, // already expired
    });
    expect(validateToken(previousToken, state, Date.now())).toBe(false);
  });

  it('rejects a token with a mismatched hostId in the payload', () => {
    // Token issued for a DIFFERENT hostId
    const wrongToken = makeToken('other-host', privateKey);
    const state = makeState();
    expect(validateToken(wrongToken, state, Date.now())).toBe(false);
  });

  it('rejects a token with a tampered signature', () => {
    const goodToken = makeToken(hostId, privateKey);
    const parts = goodToken.split('.');
    // Flip the last char of the signature part only
    const tampered = parts[0] + '.' + parts[1]!.slice(0, -1) + (parts[1]!.endsWith('X') ? 'Y' : 'X');
    // The state holds the ORIGINAL good token as currentToken;
    // the tampered token should fail signature verification.
    const state = makeState({ currentToken: goodToken });
    expect(validateToken(tampered, state, Date.now())).toBe(false);
  });

  it('rejects an unknown token (matches neither current nor previous)', () => {
    const { privateKey: otherKey } = makeKeyPair();
    const unknownToken = makeToken(hostId, otherKey); // signed by wrong key
    const state = makeState();
    expect(validateToken(unknownToken, state, Date.now())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5-3: Slot behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionManager — slot behaviour', () => {
  const { privateKey, publicKeyPem } = makeKeyPair();
  const hostId = 'host-slot-test';

  function makeValidState(): TokenState {
    const token = makeToken(hostId, privateKey);
    return {
      hostId,
      routerPublicKey: publicKeyPem,
      currentToken: token,
      previousToken: null,
      previousTokenExpiresAt: 0,
    };
  }

  beforeEach(() => {
    capturedConnectionCallback = null;
    vi.clearAllMocks();
    mockInferenceProxy.flushSlot.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function startManager(): Promise<ReturnType<typeof createSessionManager>> {
    const sm = makeManager();
    await sm.start('cert', 'key');
    sm.updateTokens(makeValidState());
    sm.setRegistered(true);
    return sm;
  }

  function openSession(tokenState: TokenState): MockTLSSocket {
    const sock = new MockTLSSocket();
    capturedConnectionCallback!(sock);
    sock.inject({ v: PROTOCOL_VERSION, type: 'session_open', hostKeyToken: tokenState.currentToken });
    return sock;
  }

  async function tick(ms = 20) {
    return new Promise((r) => setTimeout(r, ms));
  }

  it('first connection receives session_ack', async () => {
    const sm = await startManager();
    const state = makeValidState();
    sm.updateTokens(state);
    const sock = openSession(state);
    await tick();
    expect(sock.lastMessage()['type']).toBe('session_ack');
  });

  it('second connection while slot occupied receives session_reject reason: busy', async () => {
    const sm = await startManager();
    const state = makeValidState();
    sm.updateTokens(state);

    // First connection — acquires slot
    openSession(state);
    await tick();

    // Second connection — slot busy
    const state2 = makeValidState();
    sm.updateTokens(state2);
    const sock2 = openSession(state2);
    await tick();

    const msg = sock2.lastMessage();
    expect(msg['type']).toBe('session_reject');
    expect(msg['reason']).toBe('busy');
  });

  it('teardown calls inferenceProxy.flushSlot', async () => {
    const sm = await startManager();
    const state = makeValidState();
    sm.updateTokens(state);

    const sock = openSession(state);
    await tick();

    // Close the connection to trigger teardown
    sock.close();
    await tick(50);

    expect(mockInferenceProxy.flushSlot).toHaveBeenCalled();
  });

  it('calls process.exit(1) when flushSlot fails', async () => {
    mockInferenceProxy.flushSlot.mockResolvedValue(false);

    const proc = process as { exit: (code?: number) => never };
    const exitSpy: MockInstance<(code?: number) => never> = vi.spyOn(proc, 'exit').mockImplementation((_code?: number): never => {
      throw new Error('process.exit called');
    });

    const sm = await startManager();
    const state = makeValidState();
    sm.updateTokens(state);

    const sock = openSession(state);
    await tick();

    // Close triggers teardown which calls flushSlot (returns false) → process.exit(1).
    // The mock throws, which propagates as an unhandled rejection from the
    // `void doTeardown()` call. Absorb it here so Vitest does not fail the suite.
    process.once('unhandledRejection', () => undefined);
    sock.close();
    await tick(50);

    expect(exitSpy).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it('teardown releases the slot so a subsequent connection can be accepted', async () => {
    const sm = await startManager();
    const state = makeValidState();
    sm.updateTokens(state);

    const sock1 = openSession(state);
    await tick();
    expect(sock1.lastMessage()['type']).toBe('session_ack');

    // Close to trigger teardown
    sock1.close();
    await tick(50);

    // New connection should be accepted
    const state2 = makeValidState();
    sm.updateTokens(state2);
    const sock2 = openSession(state2);
    await tick();

    expect(sock2.lastMessage()['type']).toBe('session_ack');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Inference loop
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionManager — inference loop', () => {
  const { privateKey, publicKeyPem } = makeKeyPair();
  const hostId = 'host-inference-test';

  function makeValidState(): TokenState {
    const token = makeToken(hostId, privateKey);
    return { hostId, routerPublicKey: publicKeyPem, currentToken: token, previousToken: null, previousTokenExpiresAt: 0 };
  }

  beforeEach(() => {
    capturedConnectionCallback = null;
    vi.clearAllMocks();
    mockInferenceProxy.flushSlot.mockResolvedValue(true);
    mockInferenceProxy.forwardInference.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  async function startAndOpen(): Promise<{ sm: ReturnType<typeof createSessionManager>; sock: MockTLSSocket; state: TokenState }> {
    const sm = makeManager();
    await sm.start('cert', 'key');
    const state = makeValidState();
    sm.updateTokens(state);
    sm.setRegistered(true);
    const sock = new MockTLSSocket();
    capturedConnectionCallback!(sock);
    sock.inject({ v: PROTOCOL_VERSION, type: 'session_open', hostKeyToken: state.currentToken });
    await new Promise((r) => setTimeout(r, 10));
    expect(sock.lastMessage()['type']).toBe('session_ack');
    return { sm, sock, state };
  }

  it('forwardInference called with the body from inference_request', async () => {
    const { sock } = await startAndOpen();
    const body = '{"messages":[],"stream":true}';
    sock.inject({ v: PROTOCOL_VERSION, type: 'inference_request', body });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockInferenceProxy.forwardInference).toHaveBeenCalledOnce();
    expect(mockInferenceProxy.forwardInference.mock.calls[0]![0]).toBe(body);
  });

  it('SSE lines from onChunk are written as inference_response_chunk messages', async () => {
    const { sock } = await startAndOpen();
    const sseLines: string[] = [];
    mockInferenceProxy.forwardInference.mockImplementation(
      (_body: string, onChunk: (line: string) => void) => {
        onChunk('data: {"choices":[{"delta":{"content":"hello"}}]}');
        onChunk('data: [DONE]');
        return Promise.resolve();
      },
    );
    sock.inject({ v: PROTOCOL_VERSION, type: 'inference_request', body: '{}' });
    await new Promise((r) => setTimeout(r, 20));
    const msgs = sock.written.map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
    const chunks = msgs.filter((m) => m['type'] === 'inference_response_chunk');
    sseLines.push(...chunks.map((c) => c['data'] as string));
    expect(sseLines).toContain('data: {"choices":[{"delta":{"content":"hello"}}]}');
    expect(sseLines).toContain('data: [DONE]');
  });

  it('flushSlot called after normal inference completion', async () => {
    const { sock } = await startAndOpen();
    mockInferenceProxy.forwardInference.mockResolvedValue(undefined);
    sock.inject({ v: PROTOCOL_VERSION, type: 'inference_request', body: '{}' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockInferenceProxy.flushSlot).toHaveBeenCalledOnce();
  });

  it('session accepts a second inference_request after first completes', async () => {
    const { sock } = await startAndOpen();
    sock.inject({ v: PROTOCOL_VERSION, type: 'inference_request', body: '{"turn":1}' });
    await new Promise((r) => setTimeout(r, 20));
    sock.inject({ v: PROTOCOL_VERSION, type: 'inference_request', body: '{"turn":2}' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockInferenceProxy.forwardInference).toHaveBeenCalledTimes(2);
    expect(mockInferenceProxy.forwardInference.mock.calls[1]![0]).toBe('{"turn":2}');
  });

  it('socket close mid-inference: inference aborted; flushSlot called exactly once (by forwardInference)', async () => {
    const { sock } = await startAndOpen();

    let capturedSignal: AbortSignal | null = null;
    let resolveForward!: () => void;

    mockInferenceProxy.forwardInference.mockImplementation(
      (_body: string, _onChunk: unknown, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<void>((resolve) => { resolveForward = resolve; });
      },
    );
    // flushSlot is called by forwardInference on abort — simulate that
    mockInferenceProxy.flushSlot.mockResolvedValue(true);

    sock.inject({ v: PROTOCOL_VERSION, type: 'inference_request', body: '{}' });
    await new Promise((r) => setTimeout(r, 10)); // let forwardInference start

    expect(capturedSignal).not.toBeNull();

    // Close the socket — triggers teardown which aborts the controller
    sock.close();
    // Let teardown abort and await the promise
    await new Promise((r) => setTimeout(r, 10));
    resolveForward(); // resolve what forwardInference's promise was waiting for
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedSignal!.aborted).toBe(true);
    // flushSlot called exactly once — by forwardInference path (mocked), NOT by teardown again
    expect(mockInferenceProxy.flushSlot).toHaveBeenCalledTimes(0); // teardown skips it; forwardInference handles it
  });

  it('process.exit(1) when flushSlot fails after normal completion', async () => {
    mockInferenceProxy.flushSlot.mockResolvedValue(false);

    const proc = process as { exit: (code?: number) => never };
    const exitSpy: MockInstance<(code?: number) => never> = vi.spyOn(proc, 'exit').mockImplementation((_code?: number): never => {
      throw new Error('process.exit called');
    });

    const { sock } = await startAndOpen();

    process.once('unhandledRejection', () => undefined);
    sock.inject({ v: PROTOCOL_VERSION, type: 'inference_request', body: '{}' });
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });

  it('idle timer resets on each inference_request', async () => {
    vi.useFakeTimers();
    const sm = makeManager();
    await sm.start('cert', 'key');
    const state = makeValidState();
    sm.updateTokens(state);
    sm.setRegistered(true);

    const sock = new MockTLSSocket();
    capturedConnectionCallback!(sock);
    sock.inject({ v: PROTOCOL_VERSION, type: 'session_open', hostKeyToken: state.currentToken });
    await vi.advanceTimersByTimeAsync(10);

    const IDLE_MS = 30 * 60 * 1000;
    // Advance to just before idle timeout
    await vi.advanceTimersByTimeAsync(IDLE_MS - 5_000);

    // Send an inference_request — this resets the timer
    sock.inject({ v: PROTOCOL_VERSION, type: 'inference_request', body: '{}' });
    await vi.advanceTimersByTimeAsync(10);

    // Advance another IDLE_MS - 5_000 ms (total elapsed from request < IDLE_MS)
    await vi.advanceTimersByTimeAsync(IDLE_MS - 5_000);

    const messages = sock.written.map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
    expect(messages.find((m) => m['type'] === 'session_timeout')).toBeUndefined();
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5-4: Idle timer
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionManager — idle timer', () => {
  const { privateKey, publicKeyPem } = makeKeyPair();
  const hostId = 'host-idle-test';

  function makeValidState(): TokenState {
    const token = makeToken(hostId, privateKey);
    return {
      hostId,
      routerPublicKey: publicKeyPem,
      currentToken: token,
      previousToken: null,
      previousTokenExpiresAt: 0,
    };
  }

  beforeEach(() => {
    capturedConnectionCallback = null;
    vi.clearAllMocks();
    mockInferenceProxy.flushSlot.mockResolvedValue(true);
    mockInferenceProxy.forwardInference.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const IDLE_MS = 30 * 60 * 1000;

  it('sends session_timeout after 30 minutes of inactivity', async () => {
    vi.useFakeTimers();
    const sm = makeManager();
    await sm.start('cert', 'key');
    const state = makeValidState();
    sm.updateTokens(state);
    sm.setRegistered(true);

    const sock = new MockTLSSocket();
    capturedConnectionCallback!(sock);
    sock.inject({ v: PROTOCOL_VERSION, type: 'session_open', hostKeyToken: state.currentToken });
    // Let the session_open handler complete
    await vi.advanceTimersByTimeAsync(10);

    // Advance past idle timeout
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);

    const messages = sock.written.map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
    const timeoutMsg = messages.find((m) => m['type'] === 'session_timeout');
    expect(timeoutMsg).toBeDefined();
    vi.useRealTimers();
  });

  // 'resets idle timer on inference_request' test is written in host Phase 3
  // (implementation plan) alongside the full forwardInference implementation.
});
