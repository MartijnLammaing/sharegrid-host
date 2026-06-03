import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import pino from 'pino';

// ── Mock node:http ─────────────────────────────────────────────────────────────
const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock('node:http', () => ({ request: mockRequest }));

import { createInferenceProxy } from '../../src/inference-proxy.js';

const logger = pino({ level: 'silent' });

// ── Mock HTTP helpers ──────────────────────────────────────────────────────────

class MockResponse extends EventEmitter {
  statusCode: number;
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
  }
  resume() { return this; }
  setEncoding(_enc: string) { return this; }
  override destroy() { return this; }
}

class MockRequest extends EventEmitter {
  written: string[] = [];
  destroyed = false;

  write(data: string) { this.written.push(data); return true; }
  end() { return this; }
  override destroy() { this.destroyed = true; return this; }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('InferenceProxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── forwardInference ────────────────────────────────────────────────────────

  describe('forwardInference', () => {
    it('issues POST /v1/chat/completions with correct path, method, and Content-Type', async () => {
      let capturedOpts: Record<string, unknown> | null = null;

      mockRequest.mockImplementationOnce((opts: unknown, cb: unknown) => {
        capturedOpts = opts as Record<string, unknown>;
        const req = new MockRequest();
        const res = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(res);
          res.emit('data', 'data: [DONE]\n');
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      await proxy.forwardInference('{"stream":true}', vi.fn(), new AbortController().signal);

      expect(capturedOpts!['path']).toBe('/v1/chat/completions');
      expect(capturedOpts!['method']).toBe('POST');
      expect((capturedOpts!['headers'] as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('writes the body verbatim to the HTTP request', async () => {
      const body = '{"messages":[],"stream":true}';
      const req = new MockRequest();

      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const res = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(res);
          res.emit('data', 'data: [DONE]\n');
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      await proxy.forwardInference(body, vi.fn(), new AbortController().signal);

      expect(req.written).toContain(body);
    });

    it('calls onChunk for each non-empty SSE line', async () => {
      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const req = new MockRequest();
        const res = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(res);
          res.emit('data', 'data: {"choices":[{"delta":{"content":"hello"}}]}\n');
          res.emit('data', 'data: {"choices":[{"delta":{"content":" world"}}]}\n');
          res.emit('data', 'data: [DONE]\n');
        });
        return req;
      });

      const chunks: string[] = [];
      const proxy = createInferenceProxy({ logger });
      await proxy.forwardInference('{}', (line) => chunks.push(line), new AbortController().signal);

      expect(chunks).toContain('data: {"choices":[{"delta":{"content":"hello"}}]}');
      expect(chunks).toContain('data: {"choices":[{"delta":{"content":" world"}}]}');
    });

    it('does not call onChunk for blank SSE separator lines', async () => {
      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const req = new MockRequest();
        const res = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(res);
          res.emit('data', 'data: {"choices":[]}\n\n');
          res.emit('data', 'data: [DONE]\n');
        });
        return req;
      });

      const chunks: string[] = [];
      const proxy = createInferenceProxy({ logger });
      await proxy.forwardInference('{}', (line) => chunks.push(line), new AbortController().signal);

      expect(chunks.every((c) => c.length > 0)).toBe(true);
    });

    it('resolves when data: [DONE] is received', async () => {
      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const req = new MockRequest();
        const res = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(res);
          res.emit('data', 'data: [DONE]\n');
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      await expect(
        proxy.forwardInference('{}', vi.fn(), new AbortController().signal),
      ).resolves.toBeUndefined();
    });

    it('handles [DONE] split across two data events (line buffering)', async () => {
      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const req = new MockRequest();
        const res = new MockResponse(200);
        void Promise.resolve().then(async () => {
          (cb as (r: MockResponse) => void)(res);
          res.emit('data', 'data: [DO');
          await Promise.resolve(); // next microtask
          res.emit('data', 'NE]\n');
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      await expect(
        proxy.forwardInference('{}', vi.fn(), new AbortController().signal),
      ).resolves.toBeUndefined();
    });

    it('resolves when response stream ends without [DONE]', async () => {
      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const req = new MockRequest();
        const res = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(res);
          res.emit('end');
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      await expect(
        proxy.forwardInference('{}', vi.fn(), new AbortController().signal),
      ).resolves.toBeUndefined();
    });

    it('on signal abort: destroys the in-flight request', async () => {
      const controller = new AbortController();
      const postReq = new MockRequest();

      // POST — never responds (hangs until aborted)
      mockRequest.mockImplementationOnce((_opts: unknown, _cb: unknown) => postReq);
      // DELETE /slots/0 — responds with 200
      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const flushReq = new MockRequest();
        const flushRes = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(flushRes);
          flushRes.emit('end');
        });
        return flushReq;
      });

      const proxy = createInferenceProxy({ logger });
      const inferencePromise = proxy.forwardInference('{}', vi.fn(), controller.signal);

      await Promise.resolve(); // let forwardInference reach httpRequest
      controller.abort();

      await inferencePromise;

      expect(postReq.destroyed).toBe(true);
    });

    it('on signal abort: issues DELETE /slots/0 to flush the KV cache', async () => {
      const controller = new AbortController();
      let deleteOpts: Record<string, unknown> | null = null;

      // POST — hangs
      mockRequest.mockImplementationOnce((_opts: unknown, _cb: unknown) => new MockRequest());
      // DELETE /slots/0
      mockRequest.mockImplementationOnce((opts: unknown, cb: unknown) => {
        deleteOpts = opts as Record<string, unknown>;
        const flushReq = new MockRequest();
        const flushRes = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(flushRes);
          flushRes.emit('end');
        });
        return flushReq;
      });

      const proxy = createInferenceProxy({ logger });
      const p = proxy.forwardInference('{}', vi.fn(), controller.signal);

      await Promise.resolve();
      controller.abort();
      await p;

      expect(deleteOpts).not.toBeNull();
      expect(deleteOpts!['method']).toBe('DELETE');
      expect(deleteOpts!['path']).toBe('/slots/0');
    });

    it('on signal abort: resolves the promise (does not reject)', async () => {
      const controller = new AbortController();

      mockRequest.mockImplementationOnce((_opts: unknown, _cb: unknown) => new MockRequest());
      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const flushReq = new MockRequest();
        const flushRes = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(flushRes);
          flushRes.emit('end');
        });
        return flushReq;
      });

      const proxy = createInferenceProxy({ logger });
      const p = proxy.forwardInference('{}', vi.fn(), controller.signal);

      await Promise.resolve();
      controller.abort();

      await expect(p).resolves.toBeUndefined();
    });

    it('on HTTP request error: logs and resolves', async () => {
      mockRequest.mockImplementationOnce((_opts: unknown, _cb: unknown) => {
        const req = new MockRequest();
        void Promise.resolve().then(() => req.emit('error', new Error('ECONNREFUSED')));
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      await expect(
        proxy.forwardInference('{}', vi.fn(), new AbortController().signal),
      ).resolves.toBeUndefined();
    });

    it('on response stream error: logs and resolves', async () => {
      mockRequest.mockImplementationOnce((_opts: unknown, cb: unknown) => {
        const req = new MockRequest();
        const res = new MockResponse(200);
        void Promise.resolve().then(() => {
          (cb as (r: MockResponse) => void)(res);
          res.emit('error', new Error('stream broken'));
        });
        return req;
      });

      const proxy = createInferenceProxy({ logger });
      await expect(
        proxy.forwardInference('{}', vi.fn(), new AbortController().signal),
      ).resolves.toBeUndefined();
    });
  });

  // ── flushSlot ──────────────────────────────────────────────────────────────

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

      mockRequest.mockImplementation((_opts: unknown, _callback: unknown) => {
        return new MockRequest();
      });

      const proxy = createInferenceProxy({ logger });
      const flushPromise = proxy.flushSlot();

      await vi.advanceTimersByTimeAsync(5_001);

      expect(await flushPromise).toBe(false);
      vi.useRealTimers();
    });
  });
});
