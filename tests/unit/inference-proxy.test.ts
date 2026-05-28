import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import pino from 'pino';

// ── Mock node:http ─────────────────────────────────────────────────────────────
const mockRequest = vi.fn();
vi.mock('node:http', () => ({ request: mockRequest }));

const { createInferenceProxy } = await import('../../src/inference-proxy.js');

const logger = pino({ level: 'silent' });
const config = {
  SHAREGRID_ROUTER_URL: 'https://x:1?fp=sha256:' + 'a'.repeat(64),
  SHAREGRID_LISTEN_PORT: 9000,
  SHAREGRID_HEARTBEAT_INTERVAL: 30,
  SHAREGRID_MODEL_NAME: 'test-model',
  SHAREGRID_MODEL_CONTEXT_SIZE: 4096,
};

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

  describe('sendPrompt', () => {
    it('issues POST /v1/chat/completions with Content-Type and stream:true', async () => {
      const res = new MockResponse(200);
      let capturedOptions: Record<string, unknown> | null = null;
      let capturedBody = '';

      mockRequest.mockImplementation((opts: unknown, _callback: unknown) => {
        capturedOptions = opts as Record<string, unknown>;
        const req = new MockRequest();
        req.write = (data: string) => { capturedBody += data; return true; };
        void Promise.resolve().then(() => {
          const cb = _callback as (r: MockResponse) => void;
          cb(res);
          res.emit('data', 'data: [DONE]\n\n');
          res.emit('end');
        });
        return req;
      });

      const proxy = createInferenceProxy({ config, logger });
      const onChunk = vi.fn();
      const onEnd = vi.fn();
      await proxy.sendPrompt([{ role: 'user', content: 'hello' }], onChunk, onEnd);

      expect(capturedOptions!['path']).toBe('/v1/chat/completions');
      expect(capturedOptions!['method']).toBe('POST');
      const headers = capturedOptions!['headers'] as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(capturedBody) as Record<string, unknown>;
      expect(body['stream']).toBe(true);
      expect(body['model']).toBe('test-model');
      expect(body['messages']).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('calls onChunk for each non-empty delta.content in SSE stream', async () => {
      const res = new MockResponse(200);
      mockRequest.mockImplementation((_opts: unknown, callback: unknown) => {
        const req = new MockRequest();
        void Promise.resolve().then(() => {
          const cb = callback as (r: MockResponse) => void;
          cb(res);
          res.emit('data', 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }) + '\n\n');
          res.emit('data', 'data: ' + JSON.stringify({ choices: [{ delta: { content: ' world' } }] }) + '\n\n');
          res.emit('data', 'data: [DONE]\n\n');
          res.emit('end');
        });
        return req;
      });

      const proxy = createInferenceProxy({ config, logger });
      const chunks: string[] = [];
      await proxy.sendPrompt([], (c) => chunks.push(c), vi.fn());

      expect(chunks).toEqual(['hello', ' world']);
    });

    it('calls onEnd when data: [DONE] is received', async () => {
      const res = new MockResponse(200);
      mockRequest.mockImplementation((_opts: unknown, callback: unknown) => {
        const req = new MockRequest();
        void Promise.resolve().then(() => {
          (callback as (r: MockResponse) => void)(res);
          res.emit('data', 'data: [DONE]\n\n');
        });
        return req;
      });

      const proxy = createInferenceProxy({ config, logger });
      const onEnd = vi.fn();
      await proxy.sendPrompt([], vi.fn(), onEnd);
      expect(onEnd).toHaveBeenCalledOnce();
    });

    it('calls onEnd on HTTP-level error (non-fatal)', async () => {
      mockRequest.mockImplementation((_opts: unknown, _callback: unknown) => {
        const req = new MockRequest();
        void Promise.resolve().then(() => {
          req.emit('error', new Error('connection refused'));
        });
        return req;
      });

      const proxy = createInferenceProxy({ config, logger });
      const onEnd = vi.fn();
      await proxy.sendPrompt([], vi.fn(), onEnd);
      expect(onEnd).toHaveBeenCalledOnce();
    });
  });

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

      const proxy = createInferenceProxy({ config, logger });
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

      const proxy = createInferenceProxy({ config, logger });
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

      const proxy = createInferenceProxy({ config, logger });
      expect(await proxy.flushSlot()).toBe(false);
    });

    it('returns false on socket error', async () => {
      mockRequest.mockImplementation((_opts: unknown, _callback: unknown) => {
        const req = new MockRequest();
        void Promise.resolve().then(() => req.emit('error', new Error('ECONNREFUSED')));
        return req;
      });

      const proxy = createInferenceProxy({ config, logger });
      expect(await proxy.flushSlot()).toBe(false);
    });

    it('returns false on timeout (5-second cap)', async () => {
      vi.useFakeTimers();

      // Mock a request that never calls the response callback (simulating a hung connection)
      mockRequest.mockImplementation((_opts: unknown, _callback: unknown) => {
        return new MockRequest();
      });

      const proxy = createInferenceProxy({ config, logger });
      const flushPromise = proxy.flushSlot();

      // Advance past the 5-second timeout inside flushSlot
      await vi.advanceTimersByTimeAsync(5_001);

      expect(await flushPromise).toBe(false);
      vi.useRealTimers();
    });
  });
});
