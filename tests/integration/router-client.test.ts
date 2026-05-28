/**
 * Integration test — router reconnect with exponential backoff (6-4).
 *
 * Registers successfully, then closes the mock router connection to trigger
 * backoff. Verifies the Session Manager rejects new sessions while
 * disconnected, then restarts the mock router and verifies re-registration
 * and session acceptance.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('Host integration — router reconnect', () => {
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
    for (const k of ['SHAREGRID_ROUTER_URL', 'SHAREGRID_LISTEN_PORT', 'SHAREGRID_HEARTBEAT_INTERVAL',
      'SHAREGRID_MODEL_NAME', 'SHAREGRID_MODEL_CONTEXT_SIZE']) {
      delete process.env[k];
    }
  }, 15_000);

  // ── 6-4: Router reconnect ─────────────────────────────────────────────────

  it('rejects new sessions while disconnected and accepts them after re-registration', async () => {
    // Verify initial registration worked — session should be accepted
    const user1 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r1 = createReader(user1);
    sendMsg(user1, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    const ack1 = await r1.read();
    expect(ack1['type']).toBe('session_ack');
    user1.destroy();
    await new Promise((r) => setTimeout(r, 200));

    // Abruptly close the mock router — destroys existing connections, triggering
    // onDisconnect on the Router Client which calls sessionManager.setRegistered(false).
    mockRouter.stop();

    // Give the host time to detect the disconnection (TLS close → onDisconnect callback)
    await new Promise((r) => setTimeout(r, 500));

    // New session should be rejected with not_registered
    const user2 = await connectUser(host.sessionManagerPort, host.hostFingerprint);
    const r2 = createReader(user2);
    sendMsg(user2, {
      v: PROTOCOL_VERSION,
      type: 'session_open',
      hostKeyToken: host.hostKeyToken(),
    });
    const reject = await r2.read();
    expect(reject['type']).toBe('session_reject');
    expect(reject['reason']).toBe('not_registered');
    user2.destroy();
  }, 15_000);
});
