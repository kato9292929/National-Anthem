import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 追記のみのイベントログ。状態は再生で作る（M3 の永続化の土台）。
 * 壊れた行は黙って読み飛ばさない。
 */

export interface StoredEvent<T = unknown> {
  seq: number;
  at: number;
  type: string;
  payload: T;
}

export interface EventLog {
  append<T>(type: string, payload: T, at?: number): StoredEvent<T>;
  readAll(): StoredEvent[];
  readonly size: number;
}

export class MemoryEventLog implements EventLog {
  private readonly events: StoredEvent[] = [];

  append<T>(type: string, payload: T, at: number = Date.now()): StoredEvent<T> {
    const event: StoredEvent<T> = { seq: this.events.length + 1, at, type, payload };
    this.events.push(event as StoredEvent);
    return event;
  }

  readAll(): StoredEvent[] {
    return [...this.events];
  }

  get size(): number {
    return this.events.length;
  }
}

/** JSONL のファイルログ。再起動しても identity と評判が残る。 */
export class FileEventLog implements EventLog {
  private events: StoredEvent[];

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.events = existsSync(path) ? parse(readFileSync(path, 'utf8'), path) : [];
  }

  append<T>(type: string, payload: T, at: number = Date.now()): StoredEvent<T> {
    const event: StoredEvent<T> = { seq: this.events.length + 1, at, type, payload };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    this.events.push(event as StoredEvent);
    return event;
  }

  readAll(): StoredEvent[] {
    return [...this.events];
  }

  get size(): number {
    return this.events.length;
  }
}

function parse(text: string, path: string): StoredEvent[] {
  const out: StoredEvent[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line) as StoredEvent);
    } catch (cause) {
      // 壊れた行を読み飛ばすと評判が静かに消える。落とす。
      throw new Error(`${path}:${index + 1} のイベントログが壊れている: ${(cause as Error).message}`);
    }
  });
  return out;
}
