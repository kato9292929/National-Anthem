/**
 * 最小の GLB ライタ。依存を足さずに、正しい .glb バイナリを出す。
 * 生成 API のダミーとして使う（ダミーであることは呼び出し側が placeholder で記録する）。
 *
 * 出すのは単純な四角柱の集合。実物のトポロジーではないので、
 * これを「生成された実メッシュ」として扱わないこと。
 */

export interface BoxSpec {
  /** 中心 (m)。 */
  cx: number;
  cy: number;
  cz: number;
  /** サイズ (m)。 */
  sx: number;
  sy: number;
  sz: number;
}

interface MeshData {
  positions: number[];
  normals: number[];
  indices: number[];
}

function boxMesh(box: BoxSpec, out: MeshData): void {
  const { cx, cy, cz, sx, sy, sz } = box;
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const base = out.positions.length / 3;
  // 6 面、各面 4 頂点。法線を面ごとに持つ。
  const faces: { n: [number, number, number]; v: [number, number, number][] }[] = [
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
  ];
  let vi = base;
  for (const face of faces) {
    for (const v of face.v) {
      out.positions.push(v[0] + cx, v[1] + cy, v[2] + cz);
      out.normals.push(...face.n);
    }
    out.indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  }
}

/** 複数の箱を 1 メッシュにまとめて GLB バイナリにする。 */
export function writeGlb(boxes: BoxSpec[]): Buffer {
  const mesh: MeshData = { positions: [], normals: [], indices: [] };
  for (const box of boxes) boxMesh(box, mesh);

  const positions = new Float32Array(mesh.positions);
  const normals = new Float32Array(mesh.normals);
  const indices = new Uint32Array(mesh.indices);

  // bin: indices, positions, normals（4 byte 境界に揃える）。
  const parts: { data: ArrayBufferView; byteLength: number }[] = [
    { data: indices, byteLength: indices.byteLength },
    { data: positions, byteLength: positions.byteLength },
    { data: normals, byteLength: normals.byteLength },
  ];
  let offset = 0;
  const bufferViews: Record<string, number>[] = [];
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const padded = align4(part.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: part.byteLength });
    const buf = Buffer.alloc(padded);
    Buffer.from(part.data.buffer, part.data.byteOffset, part.byteLength).copy(buf);
    chunks.push(buf);
    offset += padded;
  }
  const bin = Buffer.concat(chunks);

  const bounds = boundsOf(mesh.positions);
  const gltf = {
    asset: { version: '2.0', generator: 'na-placeholder-glb' },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 2, NORMAL: 3 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { ...bufferViews[0], target: 34963 },
      { ...bufferViews[1], target: 34962 },
      { ...bufferViews[2], target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5125, count: indices.length, type: 'SCALAR' },
      { bufferView: 0, componentType: 5125, count: indices.length, type: 'SCALAR' },
      {
        bufferView: 1,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: bounds.min,
        max: bounds.max,
      },
      { bufferView: 2, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    ],
  };
  // accessors[0] は使わない冗長分を消す（primitives.indices=1 を使うため 1 本で足りる）。
  gltf.meshes[0]!.primitives[0]!.indices = 0;
  gltf.accessors.splice(1, 1);
  gltf.accessors[1]!.bufferView = 1;
  gltf.accessors[2]!.bufferView = 2;
  gltf.meshes[0]!.primitives[0]!.attributes = { POSITION: 1, NORMAL: 2 };

  const jsonBuf = padTo4(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
  const binBuf = padTo4(bin, 0x00);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binBuf.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  return Buffer.concat([header, jsonHeader, jsonBuf, binHeader, binBuf]);
}

export function triangleCount(boxes: BoxSpec[]): number {
  return boxes.length * 12;
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

function padTo4(buf: Buffer, fill: number): Buffer {
  const padded = align4(buf.length);
  if (padded === buf.length) return buf;
  const out = Buffer.alloc(padded, fill);
  buf.copy(out);
  return out;
}

function boundsOf(positions: number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}
