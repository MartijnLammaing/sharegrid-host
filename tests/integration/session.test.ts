/**
 * Integration tests — session lifecycle (6-1, 6-2, 6-3, 6-5).
 *
 * Uses real TLS sockets, real Ed25519 signing, and a real HTTP server on
 * /tmp/llama.sock that acts as llama.cpp. All timers are real except the
 * idle-timeout test (6-5) which uses vi.useFakeTimers.
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
    // Clean up env vars set by startHost
    for (const k of ['SHAREGRID_ROUTER_URL', 'SHAREGRID_LISTEN_PORT', 'SHAREGRID_HEARTBEAT_INTERVAL',
      'SHAREGRID_MODEL_NAME', 'SHAREGRID_MODEL_CONTEXT_SIZE']) {
      delete process.env[k];
    }
  }, 10_000);

  // ── 6-1: Happy path ──────────────────────────────────────────────────────

  it('happy path: session_open → session_ack → prompt → chunks → response_end → session_close', async () => {
    llamaServer.nextChunks = ['Hello', ', ', 'world'];

    const userSock = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const reader = createReader(userSock);

    try {
      // Open session
      sendMsg(userSock, {
        v: PROTOCOL_VERSION,
        type: 'session_open',
        hostKeyToken: host.hostKeyToken(),
      });
      const ack = await reader.read();
      expect(ack['type']).toBe('session_ack');

      // Send prompt
      sendMsg(userSock, {
        v: PROTOCOL_VERSION,
        type: 'prompt',
        messages: [{ role: 'user', content: 'hi' }],
      });

      // Collect response chunks + end
      const chunks: string[] = [];
      let gotEnd = false;
      while (!gotEnd) {
        const msg = await reader.read();
        if (msg['type'] === 'response_chunk') {
          chunks.push(msg['content'] as string);
        } else if (msg['type'] === 'response_end') {
          gotEnd = true;
        }
      }

      expect(chunks).toEqual(['Hello', ', ', 'world']);
      expect(gotEnd).toBe(true);

      // Close session
      sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'session_close' });
      await new Promise((r) => setTimeout(r, 200));

      // llama.cpp DELETE /slots/0 must have been called
      expect(llamaServer.flushCount).toBe(1);
    } finally {
      userSock.destroy();
    }
  }, 15_000);

  // ── 6-2: Slot busy ────────────────────────────────────────────────────────

  it('second session_open while slot occupied receives session_reject reason: busy', async () => {
    // First connection — keeps the slot
    const user1 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r1 = createReader(user1);
    sendMsg(user1, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    const ack1 = await r1.read();
    expect(ack1['type']).toBe('session_ack');

    // Second connection — slot is busy
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

    // First connection is unaffected
    sendMsg(user1, {
      v: PROTOCOL_VERSION,
      type: 'prompt',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const chunkOrEnd = await r1.read();
    expect(['response_chunk', 'response_end']).toContain(chunkOrEnd['type']);

    user1.destroy();
    user2.destroy();
    await new Promise((r) => setTimeout(r, 200));
  }, 10_000);

  // ── 6-3: Slot erase failure ───────────────────────────────────────────────

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

    // Absorb the unhandled rejection that comes from void doTeardown()
    process.once('unhandledRejection', () => undefined);

    sendMsg(userSock, { v: PROTOCOL_VERSION, type: 'session_close' });
    await new Promise((r) => setTimeout(r, 500));

    expect(exitSpy).toHaveBeenCalledWith(1);
    userSock.destroy();
    vi.restoreAllMocks();
  }, 10_000);

  // ── 6-5: Slot release after session close ────────────────────────────────
  //
  // Tests that the teardown path (slot erase → slot release) works end-to-end
  // with real sockets. The 30-minute idle timer itself is covered by the unit
  // tests (session-manager.test.ts 5-4); here we verify that after teardown
  // the slot is genuinely free and a subsequent connection is accepted.

  it('slot is released after session_close and a subsequent connection is accepted', async () => {
    // First session
    const user1 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r1 = createReader(user1);
    sendMsg(user1, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    const ack1 = await r1.read();
    expect(ack1['type']).toBe('session_ack');

    // Close cleanly — triggers teardown (flushSlot → release slot)
    sendMsg(user1, { v: PROTOCOL_VERSION, type: 'session_close' });
    await new Promise((r) => setTimeout(r, 300)); // wait for teardown
    user1.destroy();

    // Verify llama slot was flushed
    expect(llamaServer.flushCount).toBe(1);

    // A second connection must now be accepted (slot is free)
    const user2 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r2 = createReader(user2);
    sendMsg(user2, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    const ack2 = await r2.read();
    expect(ack2['type']).toBe('session_ack');
    user2.destroy();
  }, 10_000);
});
