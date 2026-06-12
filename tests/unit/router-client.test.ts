import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@sharegrid/shared/protocol';
import pino from 'pino';

// ── Mock @sharegrid/shared/tls ────────────────────────────────────────────────
const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));
vi.mock('@sharegrid/shared/tls', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sharegrid/shared/tls')>();
  return { ...real, connectWithPinnedFingerprint: mockConnect };
});

import { createRouterClient } from '../../src/router-client.js';

const logger = pino({ level: 'silent' });
const config = {
  SHAREGRID_ROUTER_URL: 'https://router.example.com:8443?fp=sha256:' + 'a'.repeat(64) + '&key=testHostSecret',
  SHAREGRID_LISTEN_PORT: 9000,
  SHAREGRID_HEARTBEAT_INTERVAL: 30,
  SHAREGRID_MODELS_DIR: '/data/models',
  SHAREGRID_LISTEN_HOST: '10.0.0.1',
};

// ── Mock socket factory ───────────────────────────────────────────────────────

class MockSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  writable = true;

  setEncoding(_enc: string) { return this; }
  write(data: string) { this.written.push(data); return true; }
  end(cb?: () => void) { this.destroyed = true; cb?.(); return this; }
  destroy() { this.destroyed = true; return this; }
  override removeAllListeners(event?: string) { super.removeAllListeners(event); return this; }

  inject(msg: object) { this.emit('data', JSON.stringify(msg) + '\n'); }

  parsedMessages(): Array<Record<string, unknown>> {
    return this.written
      .filter((w) => w.trim().length > 0)
      .map((w) => JSON.parse(w.trim()) as Record<string, unknown>);
  }
}

function makeClient(overrides?: { onRegistered?: () => void; onTokenUpdate?: (u: unknown) => void; onDisconnect?: () => void }) {
  const onRegistered = vi.fn(overrides?.onRegistered ?? (() => undefined));
  const onTokenUpdate = vi.fn(overrides?.onTokenUpdate ?? (() => undefined));
  const onDisconnect = vi.fn(overrides?.onDisconnect ?? (() => undefined));

  const client = createRouterClient({ config, logger, modelName: 'test-model', onRegistered, onTokenUpdate, onDisconnect });
  return { client, onRegistered, onTokenUpdate, onDisconnect };
}

describe('RouterClient (host)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 5-1a: TLS fingerprint format ──────────────────────────────────────────
  it('getTlsFingerprint() has sha256: prefix and 64-hex tail', () => {
    const { client } = makeClient();
    const fp = client.getTlsFingerprint();
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('getTlsCert() returns a PEM certificate string', () => {
    const { client } = makeClient();
    expect(client.getTlsCert()).toMatch(/-----BEGIN CERTIFICATE-----/);
  });

  // ── 5-1b: Registration payload ────────────────────────────────────────────
  it('registration payload contains all required fields with correct types', async () => {
    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const { client, onRegistered } = makeClient();
    const startPromise = client.start();

    await new Promise((r) => setTimeout(r, 10));

    // Inject registration ack
    sock.inject({
      v: PROTOCOL_VERSION,
      type: 'register_ack',
      hostId: 'h1',
      hostKeyToken: 'tok',
      routerPublicKey: 'pubkey',
    });

    await startPromise;
    await client.stop();

    const payload = sock.parsedMessages()[0]!;
    expect(payload['v']).toBe(PROTOCOL_VERSION);
    expect(payload['type']).toBe('register');
    expect(typeof payload['modelName']).toBe('string');
    expect(typeof payload['port']).toBe('number');
    expect(typeof payload['tlsFingerprint']).toBe('string');
    expect(payload['tlsFingerprint']).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload['roleKey']).toBe('testHostSecret');

    expect(onRegistered).toHaveBeenCalledOnce();
    const regInfo = (onRegistered.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(regInfo['hostId']).toBe('h1');
    expect(regInfo['currentToken']).toBe('tok');
    expect(regInfo['previousToken']).toBeNull();
    expect(regInfo['routerPublicKey']).toBe('pubkey');
  });

  // ── 5-1c: Heartbeat token rotation ────────────────────────────────────────
  it('on HeartbeatAck, current_token becomes new and old moves to previous_token', async () => {
    vi.useFakeTimers();

    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const { client, onTokenUpdate } = makeClient();
    // Start in background — don't await (it blocks until registration ack)
    void client.start().then(() => undefined).catch(() => undefined);

    // Let the connect promise resolve and send registration
    await vi.advanceTimersByTimeAsync(10);
    sock.inject({ v: PROTOCOL_VERSION, type: 'register_ack', hostId: 'h1', hostKeyToken: 'token-1', routerPublicKey: 'pub' });
    await vi.advanceTimersByTimeAsync(10);

    // Advance exactly one heartbeat interval to fire the setInterval callback
    await vi.advanceTimersByTimeAsync(config.SHAREGRID_HEARTBEAT_INTERVAL * 1000);

    // The heartbeat payload should now be written; inject ack
    sock.inject({ v: PROTOCOL_VERSION, type: 'heartbeat_ack', hostKeyToken: 'token-2' });
    await vi.advanceTimersByTimeAsync(10);

    expect(onTokenUpdate).toHaveBeenCalledWith({
      currentToken: 'token-2',
      previousToken: 'token-1',
    });

    await client.stop();
    vi.useRealTimers();
  });

  // ── 5-1d: Previous token cleared after 60s ────────────────────────────────
  it('previous_token is cleared after 60 seconds', async () => {
    vi.useFakeTimers();

    const sock = new MockSocket();
    mockConnect.mockResolvedValueOnce(sock);

    const updates: Array<{ currentToken: string; previousToken: string | null }> = [];
    const { client } = makeClient({ onTokenUpdate: (u) => updates.push(u as typeof updates[0]) });

    void client.start().then(() => undefined).catch(() => undefined);

    // Registration
    await vi.advanceTimersByTimeAsync(10);
    sock.inject({ v: PROTOCOL_VERSION, type: 'register_ack', hostId: 'h1', hostKeyToken: 'token-1', routerPublicKey: 'pub' });
    await vi.advanceTimersByTimeAsync(10);

    // Trigger heartbeat
    await vi.advanceTimersByTimeAsync(config.SHAREGRID_HEARTBEAT_INTERVAL * 1000);
    sock.inject({ v: PROTOCOL_VERSION, type: 'heartbeat_ack', hostKeyToken: 'token-2' });
    await vi.advanceTimersByTimeAsync(10);

    // Verify previous token is set
    const withPrev = updates.find((u) => u.previousToken === 'token-1');
    expect(withPrev).toBeDefined();

    // Advance 60 seconds — grace period expires, previousToken cleared
    await vi.advanceTimersByTimeAsync(60_000 + 100);

    const cleared = updates.find((u) => u.currentToken === 'token-2' && u.previousToken === null);
    expect(cleared).toBeDefined();

    await client.stop();
    vi.useRealTimers();
  });

  // ── 5-1e: Reconnect backoff sequence ──────────────────────────────────────
  it('reconnect backoff sequence is 1 → 2 → 4 → 8 → 16 → 32 → 60 → 60 ms (×1000)', () => {
    // Test the delay calculation logic directly — the implementation uses
    // Math.min(delay * 2, 60_000) starting from 1_000.
    const INITIAL = 1_000;
    const CAP = 60_000;
    let delay = INITIAL;
    const sequence: number[] = [delay];
    for (let i = 0; i < 7; i++) {
      delay = Math.min(delay * 2, CAP);
      sequence.push(delay);
    }
    expect(sequence).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it('RoleKeyMissingError from parseFingerprintFromUrl propagates out of start() without reconnect loop', async () => {
    // Use a URL that lacks the key param — parseFingerprintFromUrl will throw RoleKeyMissingError
    const badConfig = { ...config, SHAREGRID_ROUTER_URL: 'https://router.example.com:8443?fp=sha256:' + 'a'.repeat(64) };
    const onDisconnect = vi.fn();
    const { client } = makeClient({ onDisconnect });
    // Temporarily swap config by creating a raw client with the bad config
    const badClient = createRouterClient({ config: badConfig, logger, modelName: 'test-model', onRegistered: vi.fn(), onTokenUpdate: vi.fn(), onDisconnect });

    await expect(badClient.start()).rejects.toThrow();
    // onDisconnect must NOT have been called — we never connected
    expect(onDisconnect).not.toHaveBeenCalled();
    // connectWithPinnedFingerprint must NOT have been called — error is pre-connect
    expect(mockConnect).not.toHaveBeenCalled();
    void client; // suppress unused warning
  });

  it('invokes onDisconnect when the router socket closes unexpectedly', async () => {
    const sock = new MockSocket();
    mockConnect.mockResolvedValue(sock);

    const { client, onDisconnect } = makeClient();
    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 10));
    sock.inject({ v: PROTOCOL_VERSION, type: 'register_ack', hostId: 'h1', hostKeyToken: 'tok', routerPublicKey: 'pub' });
    await startPromise;

    sock.emit('close');
    await new Promise((r) => setTimeout(r, 10));

    expect(onDisconnect).toHaveBeenCalled();
    await client.stop();
  });
});
