import * as THREE from 'three';
import {
  requireColor,
  unconfirmedPresentation,
  type PresentationConfig,
  type RenderMode,
} from '@na/shared';

/**
 * presentation config の取り回し。
 * 値はすべてここ（config）から引く。ソースに色や強度を書かない。
 * 欠けている値は既定で補わずに落とす。
 */

export async function fetchPresentationConfig(): Promise<PresentationConfig> {
  const res = await fetch('/api/presentation/config', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`/api/presentation/config が ${res.status} を返した`);
  const body = (await res.json()) as { config: PresentationConfig };
  if (!body.config) throw new Error('presentation config が応答に含まれていない');
  return body.config;
}

export function color(config: PresentationConfig, key: string): THREE.Color {
  return new THREE.Color(requireColor(config, key));
}

export function cssColor(config: PresentationConfig, key: string): string {
  return requireColor(config, key);
}

/** パラメータは仮値なので、欠けていたら 0（＝効果なし）ではなく明示的に落とす。 */
export function param(params: Record<string, number>, key: string, where: string): number {
  const value = params[key];
  if (value === undefined) throw new Error(`${where} にパラメータ ${key} が無い`);
  return value;
}

export function initialMode(config: PresentationConfig, search: string): RenderMode {
  const requested = new URLSearchParams(search).get('render');
  if (requested === 'greybox' || requested === 'stylized') return requested;
  return config.mode;
}

export function unconfirmedList(config: PresentationConfig): string[] {
  return unconfirmedPresentation(config);
}
