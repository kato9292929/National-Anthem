import type { GeneratedMesh, MeshGenerator, MeshTarget } from './gen-types.js';
import { MeshGeneratorUnavailableError } from './gen-types.js';

/**
 * 実生成（Tripo / Meshy）のアダプタ。
 * 呼び出し形（API のエンドポイント・認証・ポーリング）は実キーのある環境で確認してから実装する。
 * ここでは interface を満たす形だけ用意し、鍵が無ければ呼ばれた時点で落とす。
 * 偽の .glb を返さない・ダミーを実物に見せない。
 */

export type LiveTool = 'tripo' | 'meshy';

export interface LiveGeneratorEnv {
  tool: LiveTool;
  apiKey?: string | undefined;
}

export function createLiveMeshGenerator(env: LiveGeneratorEnv): MeshGenerator {
  const missing: string[] = [];
  if (!env.apiKey) missing.push(`${env.tool} の API キー`);

  return {
    status: () => ({
      id: `live:${env.tool}`,
      mode: 'live',
      verified: false,
      requires: missing.length > 0 ? missing : [`${env.tool} の呼び出し形の確認（実環境）`],
      license: env.tool === 'tripo' ? '無料枠は非商用（出荷は有料プラン）' : 'CC BY（出荷は有料プラン）',
      note: '実生成は区分B。呼び出し形が確認できるまで実装しない',
    }),
    generate: (_target: MeshTarget): Promise<GeneratedMesh> =>
      Promise.reject(
        new MeshGeneratorUnavailableError(
          missing.length > 0
            ? missing
            : [`${env.tool} の image→mesh API の呼び出し形（実キーのある環境で確認して実装）`],
        ),
      ),
  };
}
