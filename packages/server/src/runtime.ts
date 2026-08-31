import { resolve } from 'node:path';
import { seedFrom, unconfirmedNames, type IdentityConfig, type RoomsConfig, type WorldConfig } from '@na/shared';
import { loadIdentityConfig, loadRoomsConfig, loadWorldConfig } from '@na/shared/node';
import { IdentityService } from './identity/service.js';
import { FileEventLog, MemoryEventLog, type EventLog } from './store/event-log.js';
import { CURRENT_MILESTONE, loadDotEnv, resolveEnv, type ResolvedEnv } from './env.js';
import { MarketSimulation } from './market/simulation.js';
import { TUNING_PROVISIONAL_NOTE } from './market/tuning.js';

export interface Runtime {
  config: WorldConfig;
  configPath: string;
  env: ResolvedEnv;
  sim: MarketSimulation;
  seedInput: string;
  identityConfig: IdentityConfig;
  roomsConfig: RoomsConfig;
  identity: IdentityService;
  eventLog: EventLog;
  /**
   * 認証は未実装（この段階の範囲外）。ローカルの単一 session identity を仮で立てる。
   * 複数プレイヤーの認証・セッション管理は別途。
   */
  localPlayerId: string;
}

/** 起動時に必ず通る道。config と env はここでしか読まない。 */
export function createRuntime(cwd = process.cwd()): Runtime {
  loadDotEnv(cwd);
  const env = resolveEnv(process.env, CURRENT_MILESTONE);
  const { config, path } = loadWorldConfig(process.env);
  const seedInput = env.require('NA_MARKET_SEED');
  const sim = new MarketSimulation({ config, seed: seedFrom(seedInput) });

  const identityConfig = loadIdentityConfig(process.env).value;
  const roomsConfig = loadRoomsConfig(process.env).value;
  const dataDir = env.get('NA_DATA_DIR');
  const eventLog: EventLog = dataDir ? new FileEventLog(resolve(cwd, dataDir, 'events.jsonl')) : new MemoryEventLog();
  const identity = new IdentityService({
    identityConfig,
    roomsConfig,
    log: eventLog,
    seed: seedFrom(seedInput),
  });
  const existing = identity.listIdentities().find((i) => i.kind === 'human');
  const localPlayer = existing ?? identity.createIdentity({ kind: 'human', externalRefs: ['base'] });
  if (!identity.activeWallet(localPlayer.id)) identity.createSessionWallet(localPlayer.id);

  return {
    config,
    configPath: path,
    env,
    sim,
    seedInput,
    identityConfig,
    roomsConfig,
    identity,
    eventLog,
    localPlayerId: localPlayer.id,
  };
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
    console.log('[economy] commission_flow は未確定');
  }
  console.log(
    `[identity] 外部資産は確定値・実照会は未検証（区分B）: ` +
      runtime.identityConfig.external_assets.erc8004.map((e) => `${e.chain}#${e.agentId}`).join(', '),
  );
  console.log(
    `[identity] standing しきい値は仮値（room gate: ` +
      runtime.roomsConfig.rooms.map((r) => `${r.id}>=${r.minStanding}`).join(', ') + '）',
  );
  console.log('[identity] 認証は未実装。ローカルの単一 session identity で通す（仮）');
}

export function resolveClientDist(cwd = process.cwd()): string {
  return resolve(cwd, 'packages/client/dist');
}
