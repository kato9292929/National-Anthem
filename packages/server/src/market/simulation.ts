import {
  createRng,
  hashString,
  type ActiveShock,
  type MarketItem,
  type MarketItemState,
  type MarketState,
  type MarketTrace,
  type WorldConfig,
} from '@na/shared';
import { buildItems, round2 } from './items.js';
import { DEFAULT_TUNING, type MarketTuning } from './tuning.js';

/**
 * サーバ権威の市場シム。
 * - Math.random は使わない。すべてシード付き rng。
 * - 同一シード＋同一の手動入力なら同一の系列になる。
 * - LLM も決済も呼ばない。
 */

interface ItemRuntime {
  item: MarketItem;
  stock: number;
  price: number;
  prevPrice: number;
  restockPerTick: number;
  demandPerTick: number;
  demandJitter: number;
}

export interface ShockInput {
  itemId: string;
  /** 1 未満で供給難。0 より大きいこと。 */
  supplyMultiplier: number;
  durationTicks: number;
  note: string;
}

export interface SimulationOptions {
  config: WorldConfig;
  seed: number;
  tuning?: MarketTuning;
}

export class MarketSimulation {
  readonly seed: number;
  private readonly tuning: MarketTuning;
  private readonly runtimes: ItemRuntime[];
  private readonly rng: ReturnType<typeof createRng>;
  private shocks: ActiveShock[] = [];
  private currentTick = 0;
  private manualShockCounter = 0;

  constructor(options: SimulationOptions) {
    this.seed = options.seed >>> 0;
    this.tuning = options.tuning ?? DEFAULT_TUNING;
    const items = buildItems(options.config, this.seed, this.tuning);
    if (items.length === 0) {
      throw new Error('stall_categories から品目を作れなかった。config を確認する');
    }
    this.rng = createRng((this.seed ^ hashString('market-tick')) >>> 0);
    this.runtimes = items.map((item) => {
      const rng = createRng((this.seed ^ hashString(`runtime:${item.id}`)) >>> 0);
      const t = this.tuning[item.direction];
      // 補充と消費は同じ throughput から振り分ける。片方だけが勝ち続けて枯渇／溢れにならないようにする。
      const throughput = item.targetStock * rng.range(t.throughputRate.min, t.throughputRate.max);
      return {
        item,
        stock: item.targetStock,
        price: item.basePrice,
        prevPrice: item.basePrice,
        restockPerTick: throughput * rng.range(t.restockBias.min, t.restockBias.max),
        demandPerTick: throughput * rng.range(t.demandBias.min, t.demandBias.max),
        demandJitter: t.demandJitter,
      };
    });
  }

  get tick(): number {
    return this.currentTick;
  }

  get items(): MarketItem[] {
    return this.runtimes.map((r) => r.item);
  }

  /** 1 tick 進める。品目ごとの rng 消費数は状態によらず一定に保つ。 */
  step(): void {
    this.currentTick += 1;
    this.shocks = this.shocks.filter((s) => s.endsTick > this.currentTick);

    for (const runtime of this.runtimes) {
      const shockRoll = this.rng.next();
      const jitterRoll = this.rng.next();
      const shockShape = this.rng.next();

      if (shockRoll < this.tuning.shockChancePerTick && !this.shockFor(runtime.item.id)) {
        this.shocks.push(this.makeScheduledShock(runtime.item.id, shockShape));
      }

      const shock = this.shockFor(runtime.item.id);
      const supplyMultiplier = shock ? shock.supplyMultiplier : 1;

      // 在庫が目標を割ったら補充が増える（平均回帰）。ショックはこの補充側を絞る。
      const deficit = 1 - runtime.stock / runtime.item.targetStock;
      const restock = Math.max(
        0,
        runtime.restockPerTick * supplyMultiplier * (1 + this.tuning.restockResponse * deficit),
      );

      // 価格が基準より高いほど消費が減る（平均回帰）。
      const priceRatio = runtime.price / runtime.item.basePrice;
      const elasticity = clamp(1 - this.tuning.demandElasticity * (priceRatio - 1), 0.1, 2);
      const jitter = 1 + (jitterRoll * 2 - 1) * runtime.demandJitter;
      const demand = Math.max(0, runtime.demandPerTick * elasticity * jitter);

      runtime.stock = Math.max(0, runtime.stock + restock - demand);

      // 在庫比から目標価格を出す。pow を使わず線形で組み、環境差で結果がぶれないようにする。
      const floorStock = runtime.item.targetStock * 0.05;
      const ratio = runtime.item.targetStock / Math.max(runtime.stock, floorStock);
      const factor = 1 + this.tuning.priceElasticity * (ratio - 1);
      const target = clamp(
        runtime.item.basePrice * factor,
        runtime.item.basePrice * this.tuning.priceFloorRatio,
        runtime.item.basePrice * this.tuning.priceCeilRatio,
      );
      runtime.prevPrice = runtime.price;
      runtime.price = round2(runtime.price + (target - runtime.price) * this.tuning.priceSmoothing);
    }
  }

  stepMany(count: number): void {
    for (let i = 0; i < count; i++) this.step();
  }

  /** 供給ショックの手動フック。手動入力も含めて同じ入力列なら再現する。 */
  applyShock(input: ShockInput): ActiveShock {
    const item = this.runtimes.find((r) => r.item.id === input.itemId);
    if (!item) throw new Error(`未知の品目: ${input.itemId}`);
    if (!(input.supplyMultiplier > 0)) throw new Error('supplyMultiplier は 0 より大きいこと');
    if (!(input.durationTicks > 0)) throw new Error('durationTicks は 0 より大きいこと');

    this.manualShockCounter += 1;
    const shock: ActiveShock = {
      id: `manual-${this.currentTick}-${this.manualShockCounter}`,
      itemId: input.itemId,
      supplyMultiplier: input.supplyMultiplier,
      startedTick: this.currentTick,
      endsTick: this.currentTick + Math.round(input.durationTicks),
      origin: 'manual',
      note: input.note,
    };
    this.shocks = [...this.shocks.filter((s) => s.itemId !== input.itemId), shock];
    return shock;
  }

  state(now: number): MarketState {
    return {
      tick: this.currentTick,
      seed: this.seed,
      items: this.items,
      states: this.runtimes.map<MarketItemState>((r) => ({
        itemId: r.item.id,
        price: r.price,
        stock: round2(r.stock),
        priceDelta: round2(r.price - r.prevPrice),
        shock: this.shockFor(r.item.id) ?? null,
      })),
      shocks: [...this.shocks],
      updatedAt: now,
    };
  }

  /** ヘッドレス実行と再現テストの照合に使う。 */
  trace(ticks: number, every = 1): MarketTrace {
    const out: MarketTrace = { seed: this.seed, ticks: [] };
    for (let i = 0; i < ticks; i++) {
      this.step();
      if (this.currentTick % every === 0) {
        out.ticks.push({
          tick: this.currentTick,
          lines: this.runtimes.map((r) => ({
            itemId: r.item.id,
            price: r.price,
            stock: round2(r.stock),
          })),
        });
      }
    }
    return out;
  }

  private shockFor(itemId: string): ActiveShock | undefined {
    return this.shocks.find((s) => s.itemId === itemId && s.endsTick > this.currentTick);
  }

  private makeScheduledShock(itemId: string, roll: number): ActiveShock {
    const { shockDurationTicks: d, shockSupplyMultiplier: m } = this.tuning;
    const duration = Math.round(d.min + roll * (d.max - d.min));
    const multiplier = round2(m.min + roll * (m.max - m.min));
    return {
      id: `scheduled-${itemId}-${this.currentTick}`,
      itemId,
      supplyMultiplier: multiplier,
      startedTick: this.currentTick,
      endsTick: this.currentTick + duration,
      origin: 'scheduled',
      note: '供給ショック（シード由来）',
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
