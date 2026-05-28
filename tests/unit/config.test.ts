import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loadConfig reads process.env at call time, so we must set env before importing.
// We reset modules before each test to get a fresh module evaluation.
describe('loadConfig', () => {
  const validEnv = {
    SHAREGRID_ROUTER_URL:
      'tls://router.example.com:8443?fp=sha256:' + 'a'.repeat(64),
    SHAREGRID_LISTEN_PORT: '7000',
    SHAREGRID_MODEL_NAME: 'llama-3-8b',
    SHAREGRID_MODEL_CONTEXT_SIZE: '4096',
  };

  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number): never => {
      throw new Error('process.exit called');
    });
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
    expect(config.SHAREGRID_MODEL_NAME).toBe('llama-3-8b');
    expect(config.SHAREGRID_MODEL_CONTEXT_SIZE).toBe(4096);
  });

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
      SHAREGRID_ROUTER_URL: 'tls://router.example.com:8443',
    });
    await expect(load()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
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
