import { arr, bool, num, obj, oneOf, str } from './guards.js';

/** config/market.config.json。連関も数値もすべて仮値（confirmed: false）。 */

export type LinkKind = 'input' | 'substitute';

export interface MarketLink {
  from: string;
  to: string;
  kind: LinkKind;
  weight: number;
}

export interface MarketStructureConfig {
  version: string;
  links: { confirmed: boolean; edges: MarketLink[] };
  shockPropagation: {
    confirmed: boolean;
    enabled: boolean;
    maxHops: number;
    decayPerHop: number;
    minEffect: number;
  };
  stalls: { confirmed: boolean; perCategory: number; priceSpread: number; stockSpread: number };
}

export function validateMarketStructureConfig(input: unknown, source: string): MarketStructureConfig {
  const root = obj(input, source, '(root)');
  const links = obj(root['links'], source, 'links');
  const propagation = obj(root['shockPropagation'], source, 'shockPropagation');
  const stalls = obj(root['stalls'], source, 'stalls');

  const edges = arr(links['edges'], source, 'links.edges').map((v, i) => {
    const o = obj(v, source, `links.edges[${i}]`);
    const edge: MarketLink = {
      from: str(o['from'], source, `links.edges[${i}].from`),
      to: str(o['to'], source, `links.edges[${i}].to`),
      kind: oneOf(o['kind'], ['input', 'substitute'] as const, source, `links.edges[${i}].kind`),
      weight: num(o['weight'], source, `links.edges[${i}].weight`),
    };
    if (edge.from === edge.to) throw new Error(`${source}: links.edges[${i}] が自分自身を指している`);
    if (edge.weight <= 0) throw new Error(`${source}: links.edges[${i}].weight は 0 より大きいこと`);
    return edge;
  });

  const perCategory = num(stalls['perCategory'], source, 'stalls.perCategory');
  if (!Number.isInteger(perCategory) || perCategory < 1) {
    throw new Error(`${source}: stalls.perCategory は 1 以上の整数`);
  }

  return {
    version: str(root['version'], source, 'version'),
    links: { confirmed: bool(links['confirmed'], source, 'links.confirmed'), edges },
    shockPropagation: {
      confirmed: bool(propagation['confirmed'], source, 'shockPropagation.confirmed'),
      enabled: bool(propagation['enabled'], source, 'shockPropagation.enabled'),
      maxHops: num(propagation['maxHops'], source, 'shockPropagation.maxHops'),
      decayPerHop: num(propagation['decayPerHop'], source, 'shockPropagation.decayPerHop'),
      minEffect: num(propagation['minEffect'], source, 'shockPropagation.minEffect'),
    },
    stalls: {
      confirmed: bool(stalls['confirmed'], source, 'stalls.confirmed'),
      perCategory,
      priceSpread: num(stalls['priceSpread'], source, 'stalls.priceSpread'),
      stockSpread: num(stalls['stockSpread'], source, 'stalls.stockSpread'),
    },
  };
}
