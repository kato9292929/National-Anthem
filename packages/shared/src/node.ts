import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.js';
import { validateIdentityConfig, validateRoomsConfig, type IdentityConfig, type RoomsConfig } from './identity.config.types.js';
import { validateWorldConfig } from './validate.js';
import { validateAgentConfig, type AgentConfig } from './agent.types.js';
import { validateCommissionConfig, type CommissionConfig } from './commission.types.js';
import { validateMarketStructureConfig, type MarketStructureConfig } from './market.config.types.js';
import { validateAssetsConfig, type AssetsConfig } from './assets.types.js';
import { validatePresentationConfig, type PresentationConfig } from './presentation.types.js';
import { validatePrivacyConfig, type PrivacyConfig } from './privacy.types.js';
import { validateVerificationEvidence, type VerificationEvidence } from './verification.types.js';
import { validateX402Config, type X402Config } from './x402.types.js';
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

/** config/ 以下の追加設定。world config と同じく、欠けていたら埋めずに落とす。 */
export function loadJsonConfig<T>(
  relativePath: string,
  validate: (input: unknown, source: string) => T,
  env: NodeJS.ProcessEnv = process.env,
): { value: T; path: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = env['NA_WORLD_CONFIG']
    ? dirname(dirname(resolveWorldConfigPath(env)))
    : findRepoRoot(here);
  const path = join(root, relativePath);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new ConfigError(`config を読めない: ${(cause as Error).message}`, { source: path });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`config が JSON として壊れている: ${(cause as Error).message}`, { source: path });
  }
  return { value: validate(parsed, path), path };
}

export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): { value: IdentityConfig; path: string } {
  return loadJsonConfig('config/identity.config.json', validateIdentityConfig, env);
}

export function loadRoomsConfig(env: NodeJS.ProcessEnv = process.env): { value: RoomsConfig; path: string } {
  return loadJsonConfig('config/rooms.config.json', validateRoomsConfig, env);
}

export function loadX402Config(env: NodeJS.ProcessEnv = process.env): { value: X402Config; path: string } {
  return loadJsonConfig('config/x402.config.json', validateX402Config, env);
}

export function loadPrivacyConfig(env: NodeJS.ProcessEnv = process.env): { value: PrivacyConfig; path: string } {
  return loadJsonConfig('config/privacy.config.json', validatePrivacyConfig, env);
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): { value: AgentConfig; path: string } {
  return loadJsonConfig('config/agent.config.json', validateAgentConfig, env);
}

export function loadCommissionConfig(env: NodeJS.ProcessEnv = process.env): {
  value: CommissionConfig;
  path: string;
} {
  return loadJsonConfig('config/commission.config.json', validateCommissionConfig, env);
}

export function loadMarketStructureConfig(env: NodeJS.ProcessEnv = process.env): {
  value: MarketStructureConfig;
  path: string;
} {
  return loadJsonConfig('config/market.config.json', validateMarketStructureConfig, env);
}

export function loadPresentationConfig(env: NodeJS.ProcessEnv = process.env): {
  value: PresentationConfig;
  path: string;
} {
  return loadJsonConfig('config/presentation.config.json', validatePresentationConfig, env);
}

export function loadVerificationEvidence(env: NodeJS.ProcessEnv = process.env): {
  value: VerificationEvidence;
  path: string;
} {
  return loadJsonConfig('config/verification-evidence.json', validateVerificationEvidence, env);
}

export function loadAssetsConfig(env: NodeJS.ProcessEnv = process.env): { value: AssetsConfig; path: string } {
  return loadJsonConfig('config/assets.config.json', validateAssetsConfig, env);
}
