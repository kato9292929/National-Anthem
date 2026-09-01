/**
 * グレイボックスの【寸法と配置】。
 * 色・質感・照明・ポスプロは presentation config（config/presentation.config.json）側に移した。
 * このファイルには色を置かない。
 * presentation.* は加藤さん確定待ち（範囲外）なので触らない。
 * ビジュアルが確定したら、この層を差し替える／上に重ねるだけで済む形にしておく。
 * ロジック（配置計算・市場表示・操作）はこのファイルの値に依存してよいが、
 * 逆にロジック側へ色や寸法をコピーしない。
 */
export const GREYBOX = {
  /** 市場空間の寸法（m）。stall 数から自動で伸びる。 */
  space: {
    aisleWidth: 9,
    marginZ: 7,
    stallSpacing: 6,
    wallHeight: 4.5,
    wallThickness: 0.5,
  },
  stall: {
    width: 3.2,
    depth: 2.2,
    height: 2.4,
    counterHeight: 1.05,
    counterOverhang: 0.5,
    labelHeight: 3.0,
    labelScale: { x: 2.3, y: 1.15 },
  },
  player: {
    eyeHeight: 1.7,
    radius: 0.45,
    walkSpeed: 5.2,
    sprintSpeed: 8.4,
    damping: 12,
    lookSensitivity: 0.0022,
    /** stall の前に立ったと見なす距離（m）。 */
    stallFocusRange: 4.5,
  },
  /** 内側の区画（standing で開閉する門）。 */
  gate: {
    partitionOffsetZ: 6,
    doorWidth: 2.2,
    doorHeight: 3.2,
    thickness: 0.45,
    labelHeight: 3.9,
  },
  camera: { fov: 70, near: 0.1, far: 220 },
} as const;
