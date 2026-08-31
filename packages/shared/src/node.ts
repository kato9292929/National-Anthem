import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.js';
import { validateWorldConfig } from './validate.js';
import type { WorldConfig } from './world-config.types.js';

/** リポジトリ内の既定位置。env NA_WORLD_CONFIG で差し替えられる。 */
export const WORLD_CONFIG_RELATIVE_PATH = 'world/world.config.json';

/** world/world.config.json を持つディレクトリを上に辿って探す。 */
export function findRepoRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    try {
      readFileSync(join(dir, WORLD_CONFIG_RELATIVE_PATH), 'utf8');
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new ConfigError(
          `${WORLD_CONFIG_RELATIVE_PATH} が見つからない。NA_WORLD_CONFIG で明示するか、リポジトリ内から実行する`,
          { source: startDir },
        );
      }
      dir = parent;
    }
  }
}

export function resolveWorldConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['NA_WORLD_CONFIG'];
  if (override && override !== '') {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return join(findRepoRoot(here), WORLD_CONFIG_RELATIVE_PATH);
}

export interface LoadedWorldConfig {
  config: WorldConfig;
  path: string;
}

/**
 * 真実の源をここだけで読む。読めない・壊れている場合は落ちる（既定値で補わない）。
 */
export function loadWorldConfig(env: NodeJS.ProcessEnv = process.env): LoadedWorldConfig {
  const path = resolveWorldConfigPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`world config を読めない: ${(cause as Error).message}`, { source: path });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`world config が JSON として壊れている: ${(cause as Error).message}`, { source: path });
  }
  return { config: validateWorldConfig(parsed, path), path };
}
