#!/usr/bin/env python3
"""
Tripo image->3D の一発生成。公式 SDK（tripo3d）を使う。
呼び出し形は公式ドキュメント準拠:
  async with TripoClient(api_key=env TRIPO_API_KEY) as client:
    task_id = await client.image_to_model(image=<path>)
    task = await client.wait_for_task(task_id)
    await client.download_task_models(task, <out_dir>)

出力の .glb は out_dir を走査して拾う（SDK の戻り値の形に依存しない）。
結果は JSON 1 行で stdout に出す。失敗は非ゼロで落ちる（偽の出力を作らない）。

  python3 tripo_generate.py --image ref.jpg --out ./out --name mudbrick

env:
  TRIPO_API_KEY  ... platform.tripo3d.ai で発行（SDK の文書化された変数名）
"""
import argparse
import asyncio
import glob
import json
import os
import sys
import time


def die(message: str, code: int = 1) -> None:
    print(json.dumps({"ok": False, "error": message}), flush=True)
    sys.exit(code)


async def run(image: str, out_dir: str) -> dict:
    try:
        from tripo3d import TripoClient, TaskStatus  # type: ignore
    except Exception as exc:  # noqa: BLE001
        die(f"tripo3d SDK がない（pip install tripo3d）: {exc}")

    api_key = os.environ.get("TRIPO_API_KEY")
    if not api_key:
        die("TRIPO_API_KEY が未設定")

    if not os.path.isfile(image):
        die(f"参照画像が無い: {image}")

    os.makedirs(out_dir, exist_ok=True)
    before = set(glob.glob(os.path.join(out_dir, "**", "*.glb"), recursive=True))

    started = time.time()
    async with TripoClient(api_key=api_key) as client:  # type: ignore
        task_id = await client.image_to_model(image=image)
        task = await client.wait_for_task(task_id)
        status = getattr(task, "status", None)
        # 成功判定は SDK の enum に合わせる。SUCCESS 以外は落とす。
        if status not in (getattr(TaskStatus, "SUCCESS", "SUCCESS"), "success", "SUCCESS", "FINISHED"):
            die(f"生成が成功しなかった: status={status} task_id={task_id}")
        await client.download_task_models(task, out_dir)

    after = set(glob.glob(os.path.join(out_dir, "**", "*.glb"), recursive=True))
    new_files = sorted(after - before)
    if not new_files:
        die("生成は完了したが .glb が出力ディレクトリに見つからない")

    return {
        "ok": True,
        "task_id": task_id,
        "glbPath": new_files[0],
        "allGlb": new_files,
        "elapsedSeconds": round(time.time() - started, 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--name", default="")
    args = parser.parse_args()
    try:
        result = asyncio.run(run(args.image, args.out))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        die(f"生成中に想定外の失敗: {exc}")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
