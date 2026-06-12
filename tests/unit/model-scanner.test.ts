import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanModels } from '../../src/model-scanner.js';

describe('scanModels', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = (await mkdir(join(tmpdir() || '/tmp', `model-scanner-test-${Date.now()}`), { recursive: true }))!;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for empty directory', async () => {
    const result = await scanModels(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns empty array for non-existent directory', async () => {
    const result = await scanModels(join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('discovers single .gguf file', async () => {
    await writeFile(join(tmpDir, 'test-model.gguf'), 'fake');
    const result = await scanModels(tmpDir);

    expect(result).toEqual([
      { name: 'test-model', path: join(tmpDir, 'test-model.gguf') },
    ]);
  });

  it('discovers multiple .gguf files sorted alphabetically', async () => {
    await writeFile(join(tmpDir, 'zeta.gguf'), 'fake');
    await writeFile(join(tmpDir, 'alpha.gguf'), 'fake');
    await writeFile(join(tmpDir, 'beta.gguf'), 'fake');

    const result = await scanModels(tmpDir);

    expect(result.map((m) => m.name)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('ignores non-.gguf files', async () => {
    await writeFile(join(tmpDir, 'model.gguf'), 'fake');
    await writeFile(join(tmpDir, 'model.bin'), 'fake');
    await writeFile(join(tmpDir, 'readme.txt'), 'fake');

    const result = await scanModels(tmpDir);

    expect(result).toEqual([
      { name: 'model', path: join(tmpDir, 'model.gguf') },
    ]);
  });

  it('strips .gguf extension from name', async () => {
    await writeFile(join(tmpDir, 'Phi-3.5-mini-instruct-IQ2_M.gguf'), 'fake');
    const result = await scanModels(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Phi-3.5-mini-instruct-IQ2_M');
  });
});
