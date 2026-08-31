/**
 * 失敗は大きく失敗させる。フォールバックで隠さない。
 * どのファイル・どのキーで落ちたかを必ずメッセージに載せる。
 */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(message: string, readonly detail?: { source?: string; key?: string }) {
    const where = detail?.source ? ` [source: ${detail.source}]` : '';
    const key = detail?.key ? ` [key: ${detail.key}]` : '';
    super(`${message}${where}${key}`);
  }
}

export class EnvError extends Error {
  override readonly name = 'EnvError';
  constructor(message: string) {
    super(message);
  }
}
