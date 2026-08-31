/**
 * world/world.config.json の型。
 * 正典は docs/world-spec-v0.md。config と矛盾したらドキュメントが勝つ。
 * ここに固有名のリテラルは書かない（naming.* は実行時に config から引く）。
 */

/** 未確定の値に付ける印。false の間は UI に確定として出さない。 */
export interface NamedValue {
  value: string;
  confirmed: boolean;
  owner: string;
}

export type NamingKey = 'market' | 'district' | 'npc' | 'stall';

export interface StallCategory {
  id: string;
  label_ja: string;
  sources_ja?: string[];
}

/** 南部が輸入する側／輸出する側。市場ロジックの向きに効く。 */
export type TradeDirection = 'import' | 'export';

export interface StallCategories {
  $comment?: string;
  imports: StallCategory[];
  exports: StallCategory[];
}

export interface CoreMappingEntry {
  id: string;
  historical_ja: string;
  maps_to: string;
  note_ja: string;
  /** 演出の強度。加藤さん確定待ちの間は "TBD"。 */
  presentation_depth: string;
}

export interface TradePartner {
  id: string;
  label_ja: string;
  role_ja: string;
  attested: boolean;
}

export interface Participant {
  id: string;
  world_role_ja: string;
  board: string;
  can_be_ja?: string[];
  capabilities?: string[];
  unattended?: boolean;
}

export interface EconomyModules {
  primary: string;
  secondary: string;
}

export interface EconomyModuleDetail {
  id: string;
  rank: string;
  label_ja: string;
  flow_ja?: string;
  categories_ref?: string;
  subordinate_to?: string;
  v0_source?: string;
  v0_note_ja?: string;
}

export interface CommissionFlow {
  $comment?: string;
  /** M0〜M2 の時点では false。実装時に v0 の範囲で詰める。 */
  confirmed: boolean;
  legs: string;
  remote_handling: string;
  settlement_unit: string;
}

export interface Economy {
  $comment?: string;
  center: string;
  center_label_ja: string;
  confirmed: boolean;
  modules: EconomyModules;
  module_detail: EconomyModuleDetail[];
  core_binding: { role: string; assigned_to_ja: string; core_mapping_ref: string }[];
  commission_flow: CommissionFlow;
}

/** 範囲外（加藤さん側）。値はすべて TBD。ロジックから参照しない。 */
export interface Presentation {
  $comment?: string;
  owner: string;
  [key: string]: unknown;
}

export interface WorldConfig {
  $comment?: string;
  version: string;
  status: string;
  setting: { id: string; summary_ja: string; resource_premise_ja: string; fiction: boolean };
  constraints: Record<string, unknown>;
  naming: Record<NamingKey, NamedValue>;
  core_mapping: CoreMappingEntry[];
  stall_categories: StallCategories;
  trade_partners: TradePartner[];
  market_logic_ja: string;
  participants: Participant[];
  economy: Economy;
  writing_premise_ja: string;
  presentation: Presentation;
}
