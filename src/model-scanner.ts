/**
 * Model Scanner — discovers .gguf model files in a directory.
 *
 * Scans the configured models directory and returns all discovered model
 * files sorted alphabetically by name. Name is derived from the filename
 * with the `.gguf` extension stripped.
 */

import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

export interface DiscoveredModel {
  /** Model name (filename without `.gguf` extension). */
  name: string;
  /** Absolute path to the model file. */
  path: string;
}

/**
 * Scan `directory` for `.gguf` files and return them sorted alphabetically
 * by name. Ignores subdirectories and non-`.gguf` files.
 */
export async function scanModels(directory: string): Promise<DiscoveredModel[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const models: DiscoveredModel[] = [];

  for (const entry of entries) {
    if (extname(entry) !== '.gguf') continue;

    models.push({
      name: entry.slice(0, -'.gguf'.length),
      path: join(directory, entry),
    });
  }

  models.sort((a, b) => a.name.localeCompare(b.name));

  return models;
}
