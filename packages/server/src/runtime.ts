import { resolve } from 'node:path';
import { seedFrom, unconfirmedNames, type WorldConfig } from '@na/shared';
import { loadWorldConfig } from '@na/shared/node';
import { CURRENT_MILESTONE, loadDotEnv, resolveEnv, type ResolvedEnv } from './env.js';
import { MarketSimulation } from './market/simulation.js';
import { TUNING_PROVISIONAL_NOTE } from './market/tuning.js';

export interface Runtime {
  config: WorldConfig;
  configPath: string;
  env: ResolvedEnv;
  sim: MarketSimulation;
  seedInput: string;
}

/** 起動時に必ず通る道。config と env はここでしか読まない。 */
export function createRuntime(cwd = process.cwd()): Runtime {
  loadDotEnv(cwd);
  const env = resolveEnv(process.env, CURRENT_MILESTONE);
  const { config, path } = loadWorldConfig(process.env);
  const seedInput = env.require('NA_MARKET_SEED');
  const sim = new MarketSimulation({ config, seed: seedFrom(seedInput) });
  return { config, configPath: path, env, sim, seedInput };
}

/** 未確定・仮値の状態を起動のたびに出す。黙って確定扱いにしない。 */
export function printStartupLabels(runtime: Runtime): void {
  const pendingNames = unconfirmedNames(runtime.config);
  console.log(`[world] config: ${runtime.configPath}`);
  console.log(`[world] 未確定の固有名: ${pendingNames.length > 0 ? pendingNames.join(', ') : 'なし'}`);
  console.log(`[world] presentation: 未着手（グレイボックスで描画）`);
  console.log(`[market] seed: ${runtime.seedInput} -> ${runtime.sim.seed}`);
  console.log(`[market] 仮値: ${TUNING_PROVISIONAL_NOTE}`);
  console.log(
    `[env] 後続で必要になるキー: ${runtime.env.pending
      .map((p) => `${p.key}(${p.requiredFrom}${p.provisional ? ',キー名仮' : ''}:${p.set ? '設定済' : '未設定'})`)
      .join(', ')}`,
  );
  if (!runtime.config.economy.commission_flow.confirmed) {
    console.log('[economy] commission_flow は未確定（M0〜M2 では使わない）');
  }
}

export function resolveClientDist(cwd = process.cwd()): string {
  return resolve(cwd, 'packages/client/dist');
}
