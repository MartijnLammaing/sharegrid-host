import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from '@vitest/spy';

// loadConfig reads process.env at call time, so we must set env before importing.
// We reset modules before each test to get a fresh module evaluation.
describe('loadConfig', () => {
  const validEnv = {
    SHAREGRID_ROUTER_URL:
      'https://router.example.com:8443?fp=sha256:' + 'a'.repeat(64) + '&key=testHostKey123',
    SHAREGRID_LISTEN_PORT: '7000',
    SHAREGRID_MODEL_FILE: 'model.gguf',
    SHAREGRID_MODEL_PATH: '/models',
    SHAREGRID_LISTEN_HOST: '192.168.1.42',
  };

  let exitSpy: MockInstance<(code?: number) => never>;

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (_code?: string | number | null): never => {
        throw new Error('process.exit called');
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(validEnv)) {
      delete process.env[key];
    }
    delete process.env['SHAREGRID_HEARTBEAT_INTERVAL'];
  });

  async function load() {
    const { loadConfig } = await import('../../src/config.js');
    return loadConfig();
  }

  it('returns parsed config with defaults when all required fields are valid', async () => {
    Object.assign(process.env, validEnv);
    const config = await load();
    expect(config.SHAREGRID_ROUTER_URL).toBe(validEnv.SHAREGRID_ROUTER_URL);
    expect(config.SHAREGRID_LISTEN_PORT).toBe(7000);
    expect(config.SHAREGRID_HEARTBEAT_INTERVAL).toBe(30);
    expect(config.SHAREGRID_MODEL_FILE).toBe('model.gguf');
    expect(config.SHAREGRID_MODEL_PATH).toBe('/models');
    expect(config.SHAREGRID_LISTEN_HOST).toBe('192.168.1.42');
  });

  it('exits with code 1 when SHAREGRID_LISTEN_HOST is missing', async () => {
    Object.assign(process.env, validEnv);
    delete process.env['SHAREGRID_LISTEN_HOST'];
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each(['not-an-ip', '256.0.0.1', '10.0.0', '::1', ''])(
    'exits with code 1 for invalid SHAREGRID_LISTEN_HOST: %s',
    async (host) => {
      Object.assign(process.env, validEnv, { SHAREGRID_LISTEN_HOST: host });
      await expect(load()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it('applies provided SHAREGRID_HEARTBEAT_INTERVAL instead of default', async () => {
    Object.assign(process.env, validEnv, { SHAREGRID_HEARTBEAT_INTERVAL: '60' });
    const config = await load();
    expect(config.SHAREGRID_HEARTBEAT_INTERVAL).toBe(60);
  });

  it('exits with code 1 when SHAREGRID_ROUTER_URL is missing', async () => {
    Object.assign(process.env, validEnv);
    delete process.env['SHAREGRID_ROUTER_URL'];
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when SHAREGRID_ROUTER_URL lacks fp query param', async () => {
    Object.assign(process.env, validEnv, {
      SHAREGRID_ROUTER_URL: 'https://router.example.com:8443?key=testHostKey123',
    });
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when SHAREGRID_ROUTER_URL has fp but no key query param', async () => {
    Object.assign(process.env, validEnv, {
      SHAREGRID_ROUTER_URL: 'https://router.example.com:8443?fp=sha256:' + 'a'.repeat(64),
    });
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('parses correctly when SHAREGRID_ROUTER_URL has both fp and key params', async () => {
    Object.assign(process.env, validEnv);
    const config = await load();
    expect(config.SHAREGRID_ROUTER_URL).toContain('key=testHostKey123');
  });

  it.each(['0', '65536', 'abc', ''])(
    'exits with code 1 for invalid SHAREGRID_LISTEN_PORT: %s',
    async (port) => {
      Object.assign(process.env, validEnv, { SHAREGRID_LISTEN_PORT: port });
      await expect(load()).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it('exits with code 1 when SHAREGRID_HEARTBEAT_INTERVAL is negative', async () => {
    Object.assign(process.env, validEnv, { SHAREGRID_HEARTBEAT_INTERVAL: '-5' });
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('defaults SHAREGRID_HEARTBEAT_INTERVAL to 30 when not set', async () => {
    Object.assign(process.env, validEnv);
    delete process.env['SHAREGRID_HEARTBEAT_INTERVAL'];
    const config = await load();
    expect(config.SHAREGRID_HEARTBEAT_INTERVAL).toBe(30);
  });
});
