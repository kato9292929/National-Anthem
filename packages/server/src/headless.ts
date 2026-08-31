import { seedFrom } from '@na/shared';
import { createRuntime, printStartupLabels } from './runtime.js';
import { MarketSimulation } from './market/simulation.js';

/**
 * クライアント無しで市場が動くことを確かめる実行口。
 *   npm run sim -- --ticks 200 --every 40 --seed na-v0-0001
 */

interface Args {
  ticks: number;
  every: number;
  seed?: string;
  shockAt?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ticks: 200, every: 40 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`引数 ${key} に値が無い`);
    switch (key) {
      case '--ticks':
        args.ticks = Number(value);
        break;
      case '--every':
        args.every = Number(value);
        break;
      case '--seed':
        args.seed = value;
        break;
      case '--shock-at':
        args.shockAt = Number(value);
        break;
      default:
        throw new Error(`未知の引数: ${key}`);
    }
  }
  return args;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.seed !== undefined) process.env['NA_MARKET_SEED'] = args.seed;

  const runtime = createRuntime();
  printStartupLabels(runtime);

  const sim = new MarketSimulation({ config: runtime.config, seed: seedFrom(runtime.seedInput) });
  const items = sim.items;
  const first = sim.state(0);

  console.log('');
  console.log(`[sim] ${args.ticks} ticks / ${items.length} 品目（config の stall_categories 由来）`);
  console.log(
    ['tick'.padStart(6), ...items.map((i) => padStart(`${i.id}`, 14))].join(' '),
  );
  console.log(
    [''.padStart(6), ...items.map((i) => padStart(i.direction === 'import' ? '(輸入)' : '(輸出)', 14))].join(' '),
  );

  const row = (tick: number): string => {
    const state = sim.state(0);
    return [
      padStart(String(tick), 6),
      ...state.states.map((s) => padStart(`${s.price.toFixed(1)}/${Math.round(s.stock)}`, 14)),
    ].join(' ');
  };

  console.log(row(0));
  for (let t = 1; t <= args.ticks; t++) {
    sim.step();
    if (args.shockAt !== undefined && t === args.shockAt) {
      const target = items[0];
      if (target) {
        const shock = sim.applyShock({
          itemId: target.id,
          supplyMultiplier: 0.2,
          durationTicks: 30,
          note: '手動フックの確認',
        });
        console.log(`[shock] tick ${t}: ${shock.itemId} 供給 x${shock.supplyMultiplier}（${shock.note}）`);
      }
    }
    if (t % args.every === 0) console.log(row(t));
  }

  const last = sim.state(0);
  console.log('');
  console.log('[sim] 価格/在庫の変化（tick 0 -> 最終）:');
  for (const item of items) {
    const a = first.states.find((s) => s.itemId === item.id);
    const b = last.states.find((s) => s.itemId === item.id);
    if (!a || !b) throw new Error(`state が欠けている: ${item.id}`);
    console.log(
      `  ${pad(item.id, 12)} price ${a.price.toFixed(2)} -> ${b.price.toFixed(2)}` +
        `  stock ${a.stock.toFixed(1)} -> ${b.stock.toFixed(1)}`,
    );
  }
  const scheduled = last.shocks.filter((s) => s.origin === 'scheduled');
  console.log(`[sim] 進行中のショック: ${last.shocks.length}（うちシード由来 ${scheduled.length}）`);
  console.log('[sim] LLM 呼び出し 0 / 決済 0');
}

main();
