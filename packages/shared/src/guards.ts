import { ConfigError } from './errors.js';

/**
 * config 検証の共通部品。欠けている値を既定値で埋めない。
 * どのファイルのどのキーで落ちたかを必ずメッセージに載せる。
 */

export function fail(message: string, source: string, key?: string): never {
  throw new ConfigError(message, key === undefined ? { source } : { source, key });
}

export function describe(value: unknown): string {
  if (value === undefined) return 'undefined（キーが無い）';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

export function obj(value: unknown, source: string, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`オブジェクトである必要がある（実際: ${describe(value)}）`, source, key);
  }
  return value as Record<string, unknown>;
}

export function arr(value: unknown, source: string, key: string): unknown[] {
  if (!Array.isArray(value)) fail(`配列である必要がある（実際: ${describe(value)}）`, source, key);
  return value;
}

export function str(value: unknown, source: string, key: string): string {
  if (typeof value !== 'string' || value === '') {
    fail(`空でない文字列である必要がある（実際: ${describe(value)}）`, source, key);
  }
  return value;
}

export function num(value: unknown, source: string, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`有限の数値である必要がある（実際: ${describe(value)}）`, source, key);
  }
  return value;
}

export function bool(value: unknown, source: string, key: string): boolean {
  if (typeof value !== 'boolean') fail(`真偽値である必要がある（実際: ${describe(value)}）`, source, key);
  return value;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  source: string,
  key: string,
): T {
  const s = str(value, source, key);
  if (!allowed.includes(s as T)) {
    fail(`${allowed.join(' | ')} のいずれかである必要がある（実際: ${s}）`, source, key);
  }
  return s as T;
}
