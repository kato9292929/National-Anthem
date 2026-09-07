import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeneratedMesh, MeshGenerator, MeshGeneratorStatus, MeshTarget } from './gen-types.js';
import { MeshGeneratorUnavailableError } from './gen-types.js';

/**
 * Tripo の image→3D 実装。
 * 呼び出し形は公式 Python SDK（tripo3d）に委ねる（native REST の base URL を推測しない）。
 * py/tripo_generate.py を subprocess で呼び、出力 .glb のパスを受け取る。
 *
 * - 鍵（TRIPO_API_KEY）が無ければ呼ばれた時点で落ちる。偽 .glb を作らない。
 * - Python / SDK が無い、生成が成功しない、.glb が出ない、はいずれも fail-loud。
 * - 実 .glb なので placeholder は false。実確認が通るまで verified は false のまま。
 *
 * ライセンス: Tripo 無料枠は非商用。出荷は有料プランで所有権を取るまで本番に出さない。
 */

export interface TripoGeneratorOptions {
  apiKey?: string | undefined;
  outputDir: string;
  /** 参照画像のパスを target ごとに引く。 */
  imageFor: (target: MeshTarget) => string | undefined;
  /** python 実行コマンド。既定は python3。 */
  pythonBin?: string | undefined;
  /** 1 回あたりのコスト目安（USD）。実測は区分B で入れる。 */
  estimatedCostUsd?: number | undefined;
}

const PY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../py/tripo_generate.py');

interface TripoResult {
  ok: boolean;
  error?: string;
  task_id?: string;
  glbPath?: string;
  elapsedSeconds?: number;
}

export function createTripoMeshGenerator(options: TripoGeneratorOptions): MeshGenerator {
  const pythonBin = options.pythonBin ?? 'python3';

  const status = (): MeshGeneratorStatus => {
    const requires: string[] = [];
    if (!options.apiKey) requires.push('TRIPO_API_KEY');
    if (!existsSync(PY_SCRIPT)) requires.push(`Python ラッパ ${PY_SCRIPT}`);
    return {
      id: 'live:tripo',
      mode: 'live',
      // 実生成が通るまで false。実装完了では上げない。
      verified: false,
      requires: requires.length > 0 ? requires : ['実生成の 1 回（区分B）'],
      license: '無料枠は非商用（出荷は有料プランで所有権を取るまで本番に出さない）',
      note: '公式 SDK（tripo3d）に委ねる。native REST を推測しない',
    };
  };

  return {
    status,
    async generate(target: MeshTarget): Promise<GeneratedMesh> {
      if (!options.apiKey) throw new MeshGeneratorUnavailableError(['TRIPO_API_KEY']);
      const image = options.imageFor(target);
      if (!image) throw new MeshGeneratorUnavailableError([`${target.slot} の参照画像`]);
      if (!existsSync(image)) throw new Error(`参照画像が無い: ${image}`);
      if (!existsSync(PY_SCRIPT)) throw new Error(`Python ラッパが無い: ${PY_SCRIPT}`);

      const result = await runPython(pythonBin, PY_SCRIPT, {
        image,
        out: options.outputDir,
        name: target.name,
        env: { TRIPO_API_KEY: options.apiKey },
      });

      if (!result.ok || !result.glbPath) {
        // 生成失敗を成功に見せない。フォールバックの .glb を作らない。
        throw new Error(`Tripo 生成に失敗: ${result.error ?? '不明'}`);
      }
      return {
        target,
        glbPath: result.glbPath,
        placeholder: false,
        source: `tripo image_to_model (task ${result.task_id ?? '?'}, from: ${target.reference})`,
        // 実物のポリゴン数は import 段で数える。ここでは 0（未計測）を返さず -1 で「未計測」を示す。
        triangles: -1,
        costUsd: options.estimatedCostUsd ?? -1,
      };
    },
  };
}

function runPython(
  bin: string,
  script: string,
  input: { image: string; out: string; name: string; env: Record<string, string> },
): Promise<TripoResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [script, '--image', input.image, '--out', input.out, '--name', input.name], {
      env: { ...process.env, ...input.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => reject(new Error(`python を起動できない（${bin}）: ${error.message}`)));
    child.on('close', (code) => {
      // 最後の JSON 行を読む（SDK の verbose ログが混ざっても拾える）。
      const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).at(-1);
      if (!line) {
        reject(new Error(`Tripo ラッパの応答が読めない（exit ${code}）: ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(line) as TripoResult);
      } catch (error) {
        reject(new Error(`Tripo ラッパの JSON を読めない: ${(error as Error).message}`));
      }
    });
  });
}
