/**
 * Integration tests — session lifecycle (Phase 2 protocol).
 *
 * Uses real TLS sockets, real Ed25519 signing, and a real HTTP server on
 * a tmp Unix socket that acts as llama.cpp. Exercises the Phase 2 protocol:
 * inference_request → inference_response_chunk stream → data: [DONE].
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@sharegrid/shared/protocol';
import {
  startMockRouter,
  startMockLlamaServer,
  startHost,
  connectUser,
  sendMsg,
  createReader,
  sendInferenceRequest,
  type MockRouter,
  type MockLlamaServer,
  type HostStack,
} from './helpers.js';

describe('Host integration — session', () => {
  let mockRouter: MockRouter;
  let llamaServer: MockLlamaServer;
  let host: HostStack;

  beforeEach(async () => {
    mockRouter  = await startMockRouter();
    llamaServer = await startMockLlamaServer();
    host        = await startHost(mockRouter, llamaServer.socketPath);
  }, 15_000);

  afterEach(async () => {
    await host.stop();
    mockRouter.stop();
    llamaServer.stop();
    vi.useRealTimers();
    for (const k of [
      'SHAREGRID_ROUTER_URL', 'SHAREGRID_LISTEN_PORT', 'SHAREGRID_HEARTBEAT_INTERVAL',
      'SHAREGRID_MODEL_FILE', 'SHAREGRID_MODEL_PATH',
    ]) {
      delete process.env[k];
    }
  }, 10_000);

  // ── Happy path ────────────────────────────────────────────────────────────

  it('session_open → session_ack → inference_request → SSE chunks → [DONE] → session_close', async () => {
    llamaServer.nextChunks = ['Hello', ', ', 'world'];

    const userSock = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const reader = createReader(userSock);

    try {
      sendMsg(userSock, {
        v: PROTOCOL_VERSION,
        type: 'session_open',
        hostKeyToken: host.hostKeyToken(),
      });
      const ack = await reader.read();
      expect(ack['type']).toBe('session_ack');

      const lines = await sendInferenceRequest(userSock, reader, '{"stream":true}');

      // The host must have forwarded one SSE line per chunk plus [DONE]
      expect(lines.some((l) => l.includes('"Hello"'))).toBe(true);
      expect(lines.some((l) => l.includes('"world"'))).toBe(true);
      expect(lines[lines.length - 1]).toBe('data: [DONE]');

      sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'session_close' });
      await new Promise((r) => setTimeout(r, 300));

      // Session manager must flush the KV cache after the turn
      expect(llamaServer.flushCount).toBeGreaterThanOrEqual(1);
    } finally {
      userSock.destroy();
    }
  }, 15_000);

  // ── Slot busy ─────────────────────────────────────────────────────────────

  it('second session_open while slot occupied receives session_reject reason: busy', async () => {
    const user1 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r1 = createReader(user1);
    sendMsg(user1, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    const ack1 = await r1.read();
    expect(ack1['type']).toBe('session_ack');

    // Verify first session is usable with inference
    const lines = await sendInferenceRequest(user1, r1, '{}');
    expect(lines[lines.length - 1]).toBe('data: [DONE]');

    // Second connection — slot is still busy (session is open between turns)
    const user2 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r2 = createReader(user2);
    sendMsg(user2, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    const reject = await r2.read();
    expect(reject['type']).toBe('session_reject');
    expect(reject['reason']).toBe('busy');

    user1.destroy();
    user2.destroy();
    await new Promise((r) => setTimeout(r, 300));
  }, 10_000);

  // ── Slot erase failure ────────────────────────────────────────────────────

  it('slot erase failure (llama.cpp returns 500) triggers process.exit(1)', async () => {
    llamaServer.flushShouldFail = true;

    const proc = process as { exit: (code?: number) => never };
    const exitSpy = vi.spyOn(proc, 'exit').mockImplementation((): never => undefined as never);

    const userSock = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const rSlot = createReader(userSock);
    sendMsg(userSock, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    await rSlot.read(); // session_ack

    process.once('unhandledRejection', () => undefined);

    sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'session_close' });
    await new Promise((r) => setTimeout(r, 500));

    expect(exitSpy).toHaveBeenCalledWith(1);
    userSock.destroy();
    vi.restoreAllMocks();
  }, 10_000);

  // ── Slot release after session close ──────────────────────────────────────

  it('slot is released after session_close and a subsequent connection is accepted', async () => {
    const user1 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r1 = createReader(user1);
    sendMsg(user1, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    expect((await r1.read())['type']).toBe('session_ack');

    sendMsg(user1, { v: PROTOCOL_VERSION, type: 'session_close' });
    await new Promise((r) => setTimeout(r, 400));
    user1.destroy();

    expect(llamaServer.flushCount).toBeGreaterThanOrEqual(1);

    const user2 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r2 = createReader(user2);
    sendMsg(user2, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    expect((await r2.read())['type']).toBe('session_ack');
    user2.destroy();
  }, 10_000);

  // ── Multi-turn ────────────────────────────────────────────────────────────

  it('multi-turn: second inference_request on same session is accepted after first completes', async () => {
    llamaServer.nextChunks = ['A'];

    const userSock = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const reader = createReader(userSock);

    try {
      sendMsg(userSock, {
        v: PROTOCOL_VERSION,
        type: 'session_open',
        hostKeyToken: host.hostKeyToken(),
      });
      expect((await reader.read())['type']).toBe('session_ack');

      // Turn 1
      const lines1 = await sendInferenceRequest(userSock, reader, '{"turn":1}');
      expect(lines1[lines1.length - 1]).toBe('data: [DONE]');
      await new Promise((r) => setTimeout(r, 50)); // let flush complete
      const flushAfterTurn1 = llamaServer.flushCount;
      expect(flushAfterTurn1).toBe(1);

      // Turn 2 — session must still be open
      llamaServer.nextChunks = ['B'];
      const lines2 = await sendInferenceRequest(userSock, reader, '{"turn":2}');
      expect(lines2[lines2.length - 1]).toBe('data: [DONE]');
      await new Promise((r) => setTimeout(r, 50));
      expect(llamaServer.flushCount).toBe(2);

      // Close gracefully
      sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'session_close' });
      await new Promise((r) => setTimeout(r, 300));
      // Teardown flush: no inference in progress, so teardown calls flushSlot once more
      expect(llamaServer.flushCount).toBe(3);
    } finally {
      userSock.destroy();
    }
  }, 15_000);
});
