import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

const spawnMock = vi.fn();
const accessMock = vi.fn();
const rmSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs/promises', () => ({
  access: accessMock,
}));

vi.mock('node:fs', () => ({
  rmSync: rmSyncMock,
}));

describe('launchLlama', () => {
  let stdout: EventEmitter;
  let stderr: EventEmitter;
  let fakeProcess: ChildProcess & EventEmitter;

  function createLogger() {
    const logger = {
      child: vi.fn(() => logger),
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    return logger;
  }

  beforeEach(() => {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    fakeProcess = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
    }) as ChildProcess & EventEmitter;

    spawnMock.mockReturnValue(fakeProcess);
    accessMock.mockResolvedValue(undefined);
    rmSyncMock.mockReturnValue(undefined);

    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function importLauncher() {
    const { launchLlama } = await import('../../src/llama-launcher.js');
    return launchLlama;
  }

  it('spawns the configured binary directly when no sandbox profile is set', async () => {
    const launchLlama = await importLauncher();
    const promise = launchLlama({
      activeModelPath: '/data/models/model.gguf',
      contextSize: 4096,
      maxSessions: 1,
      llamaBinary: '/app/llama-server',
      sandboxProfilePath: undefined,
      logger: createLogger() as never,
    });

    // Allow the readiness poll to run once.
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBeUndefined();

    expect(rmSyncMock).toHaveBeenCalledTimes(1);
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/llama.sock', { force: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('/app/llama-server');
    expect(args).toEqual([
      '--model', '/data/models/model.gguf',
      '--host', '/tmp/llama.sock',
      '--parallel', '1',
      '--ctx-size', '4096',
    ]);
  });

  it('wraps the binary in sandbox-exec when a sandbox profile is set', async () => {
    const launchLlama = await importLauncher();
    const promise = launchLlama({
      activeModelPath: '/data/models/model.gguf',
      contextSize: 4096,
      maxSessions: 2,
      llamaBinary: '/opt/bin/llama-server',
      sandboxProfilePath: '/etc/sharegrid.sb',
      logger: createLogger() as never,
    });

    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toBeUndefined();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('sandbox-exec');
    expect(args.slice(0, 4)).toEqual([
      '-f', '/etc/sharegrid.sb',
      '-D', 'LLAMA_BINARY=/opt/bin/llama-server',
    ]);
    expect(args[4]).toBe('-D');
    expect(args[5]).toBe('MODELS_DIR=/data/models');
    expect(args[6]).toBe('/opt/bin/llama-server');
    expect(args.slice(7)).toEqual([
      '--model', '/data/models/model.gguf',
      '--host', '/tmp/llama.sock',
      '--parallel', '2',
      '--ctx-size', '4096',
    ]);
  });
});
