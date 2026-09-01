import {
  createRng,
  hashString,
  type ActiveShock,
  type MarketItem,
  type MarketItemState,
  type MarketStallState,
  type MarketState,
  type MarketStructureConfig,
  type MarketTrace,
  type PropagatedEffect,
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
  /** カテゴリ間の連関と stall 分布。未指定なら連関なし・1 カテゴリ 1 stall。 */
  structure?: MarketStructureConfig;
}

export class MarketSimulation {
  readonly seed: number;
  private readonly tuning: MarketTuning;
  private readonly runtimes: ItemRuntime[];
  private readonly rng: ReturnType<typeof createRng>;
  private shocks: ActiveShock[] = [];
  private currentTick = 0;
  private manualShockCounter = 0;
  private readonly structure: MarketStructureConfig | null;
  /** stall ごとの分布係数。tick ごとに計算し直さない（決定論を保つ）。 */
  private readonly stallShares = new Map<string, { id: string; stockShare: number; priceFactor: number }[]>();

  constructor(options: SimulationOptions) {
    this.seed = options.seed >>> 0;
    this.tuning = options.tuning ?? DEFAULT_TUNING;
    const items = buildItems(options.config, this.seed, this.tuning);
    if (items.length === 0) {
      throw new Error('stall_categories から品目を作れなかった。config を確認する');
    }
    this.structure = options.structure ?? null;
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
    this.buildStallShares(items);
  }

  /** 1 カテゴリを何軒で分け持つか。配分はシードから決まる（毎 tick 振り直さない）。 */
  private buildStallShares(items: MarketItem[]): void {
    const perCategory = this.structure?.stalls.perCategory ?? 1;
    const stockSpread = this.structure?.stalls.stockSpread ?? 0;
    const priceSpread = this.structure?.stalls.priceSpread ?? 0;

    for (const item of items) {
      const rng = createRng((this.seed ^ hashString(`stalls:${item.id}`)) >>> 0);
      const raw: number[] = [];
      for (let i = 0; i < perCategory; i++) raw.push(1 + (rng.next() * 2 - 1) * stockSpread);
      const total = raw.reduce((sum, v) => sum + v, 0);
      this.stallShares.set(
        item.id,
        raw.map((value, index) => ({
          id: `${item.id}-${index + 1}`,
          stockShare: value / total,
          priceFactor: 1 + (rng.next() * 2 - 1) * priceSpread,
        })),
      );
    }
  }

  /**
   * 連関をたどってショックを伝える。
   * 直撃した品目の不足が、その品目を投入に使う品目の供給を削る。
   * 連関そのものが仮の設定なので、影響には出所（fromItemId / hops）を必ず残す。
   */
  private propagation(): Map<string, PropagatedEffect[]> {
    const out = new Map<string, PropagatedEffect[]>();
    const propagationConfig = this.structure?.shockPropagation;
    if (!this.structure || !propagationConfig?.enabled) return out;

    const edges = this.structure.links.edges;
    for (const shock of this.shocks) {
      if (shock.endsTick <= this.currentTick) continue;
      const severity = Math.max(0, 1 - shock.supplyMultiplier);
      if (severity <= 0) continue;

      // 幅優先で maxHops まで。減衰が minEffect を下回ったら止める。
      let frontier: { itemId: string; effect: number; hops: number }[] = [
        { itemId: shock.itemId, effect: severity, hops: 0 },
      ];
      const visited = new Set<string>([shock.itemId]);
      while (frontier.length > 0) {
        const next: { itemId: string; effect: number; hops: number }[] = [];
        for (const node of frontier) {
          if (node.hops >= propagationConfig.maxHops) continue;
          for (const edge of edges.filter((e) => e.from === node.itemId)) {
            const effect = node.effect * edge.weight * propagationConfig.decayPerHop;
            if (effect < propagationConfig.minEffect) continue;
            if (visited.has(edge.to)) continue;
            visited.add(edge.to);
            const list = out.get(edge.to) ?? [];
            list.push({ fromItemId: shock.itemId, hops: node.hops + 1, effect: round2(effect) });
            out.set(edge.to, list);
            next.push({ itemId: edge.to, effect, hops: node.hops + 1 });
          }
        }
        frontier = next;
      }
    }
    return out;
  }

  /** 直撃と伝播を合わせた実効の供給倍率。 */
  private effectiveSupply(itemId: string, propagated: Map<string, PropagatedEffect[]>): number {
    const direct = this.shockFor(itemId)?.supplyMultiplier ?? 1;
    const effects = propagated.get(itemId) ?? [];
    const reduction = effects.reduce((sum, e) => sum + e.effect, 0);
    return clamp(direct * (1 - reduction), 0.02, 1);
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
    const propagated = this.propagation();

    for (const runtime of this.runtimes) {
      const shockRoll = this.rng.next();
      const jitterRoll = this.rng.next();
      const shockShape = this.rng.next();

      if (shockRoll < this.tuning.shockChancePerTick && !this.shockFor(runtime.item.id)) {
        this.shocks.push(this.makeScheduledShock(runtime.item.id, shockShape));
      }

      const supplyMultiplier = this.effectiveSupply(runtime.item.id, propagated);

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
    const propagated = this.propagation();
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
        supplyMultiplier: round2(this.effectiveSupply(r.item.id, propagated)),
        propagation: propagated.get(r.item.id) ?? [],
      })),
      shocks: [...this.shocks],
      stalls: this.stalls(),
      updatedAt: now,
    };
  }

  /** カテゴリ単位の値が正。stall はその分布。 */
  stalls(): MarketStallState[] {
    const out: MarketStallState[] = [];
    for (const runtime of this.runtimes) {
      const shares = this.stallShares.get(runtime.item.id) ?? [];
      for (const share of shares) {
        out.push({
          id: share.id,
          itemId: runtime.item.id,
          stock: round2(runtime.stock * share.stockShare),
          price: round2(runtime.price * share.priceFactor),
          provisional: true,
        });
      }
    }
    return out;
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
