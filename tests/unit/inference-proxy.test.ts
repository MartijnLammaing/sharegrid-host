import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import pino from 'pino';

// ── Mock node:http ─────────────────────────────────────────────────────────────
const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock('node:http', () => ({ request: mockRequest }));

import { createInferenceProxy } from '../../src/inference-proxy.js';

const logger = pino({ level: 'silent' });

// ── Helpers for mock HTTP ──────────────────────────────────────────────────────

class MockResponse extends EventEmitter {
  statusCode: number;
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
  }
  resume() { return this; }
  setEncoding(_enc: string) { return this; }
}

class MockRequest extends EventEmitter {
  written: string[] = [];
  destroyed = false;

  write(data: string) { this.written.push(data); return true; }
  end() { return this; }
  destroy() { this.destroyed = true; return this; }
  setTimeout(_ms: number, cb: () => void) {
    (this as Record<string, unknown>)['_timeoutCb'] = cb;
    return this;
  }
}

describe('InferenceProxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // sendPrompt / cancelPrompt removed in Phase 2 — see implementation_plan_llmhost.md Phase 1
  // for forwardInference tests (written when the full implementation lands).

  describe('flushSlot', () => {
    it('returns true on HTTP 200', async () => {
      const res = new MockResponse(200);
      mockRequest.mockImplementation((_opts: unknown, callback: unknown) => {
        const req = new MockRequest();
        void Promise.resolve().then(() => {
          (callback as (r: MockResponse) => void)(res);
          res.emit('end');
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      expect(await proxy.flushSlot()).toBe(true);
    });

    it('issues DELETE /slots/0', async () => {
      const res = new MockResponse(200);
      let capturedOptions: Record<string, unknown> | null = null;
      mockRequest.mockImplementation((opts: unknown, callback: unknown) => {
        capturedOptions = opts as Record<string, unknown>;
        const req = new MockRequest();
        void Promise.resolve().then(() => {
          (callback as (r: MockResponse) => void)(res);
          res.emit('end');
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      await proxy.flushSlot();
      expect(capturedOptions!['path']).toBe('/slots/0');
      expect(capturedOptions!['method']).toBe('DELETE');
    });

    it('returns false on HTTP 500', async () => {
      const res = new MockResponse(500);
      mockRequest.mockImplementation((_opts: unknown, callback: unknown) => {
        const req = new MockRequest();
        void Promise.resolve().then(() => {
          (callback as (r: MockResponse) => void)(res);
          res.emit('end');
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      expect(await proxy.flushSlot()).toBe(false);
    });

    it('returns false on socket error', async () => {
      mockRequest.mockImplementation((_opts: unknown, _callback: unknown) => {
        const req = new MockRequest();
        void Promise.resolve().then(() => req.emit('error', new Error('ECONNREFUSED')));
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      expect(await proxy.flushSlot()).toBe(false);
    });

    it('returns false on timeout (5-second cap)', async () => {
      vi.useFakeTimers();

      // Mock a request that never calls the response callback (simulating a hung connection)
      mockRequest.mockImplementation((_opts: unknown, _callback: unknown) => {
        return new MockRequest();
      });

      const proxy = createInferenceProxy({ logger });
      const flushPromise = proxy.flushSlot();

      // Advance past the 5-second timeout inside flushSlot
      await vi.advanceTimersByTimeAsync(5_001);

      expect(await flushPromise).toBe(false);
      vi.useRealTimers();
    });
  });
});
