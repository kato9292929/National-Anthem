import type { AgentConfig } from '@na/shared';
import { assertGatesSatisfied, type DryRunMeasurement } from './gate.js';

/**
 * エージェントを定期実行に載せる唯一の入口。
 * 稼働前ゲートを満たすまでここで止まる（実測前に schedule で回さない）。
 */

export interface AgentLoopHandle {
  stop(): void;
  tickIntervalSeconds: number;
}

export function startAgentLoop(input: {
  config: AgentConfig;
  measurement: DryRunMeasurement | null;
  onTick: () => void | Promise<void>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}): AgentLoopHandle {
  assertGatesSatisfied(input.config, input.measurement);
  const interval = input.config.cadence.tickIntervalSeconds;
  if (interval === null) {
    // ゲートを通っていればここには来ないが、型と実体の両方で守る。
    throw new Error('tick 頻度が未確定のまま schedule に載せようとした');
  }
  const setIntervalFn = input.setIntervalImpl ?? setInterval;
  const clearIntervalFn = input.clearIntervalImpl ?? clearInterval;
  const timer = setIntervalFn(() => void input.onTick(), interval * 1000);
  return {
    tickIntervalSeconds: interval,
    stop: () => clearIntervalFn(timer),
  };
}
