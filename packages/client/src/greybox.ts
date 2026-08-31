/**
 * グレイボックスの見た目の値は【すべてここだけ】に置く。
 * presentation.* は加藤さん確定待ち（範囲外）なので触らない。
 * ビジュアルが確定したら、この層を差し替える／上に重ねるだけで済む形にしておく。
 * ロジック（配置計算・市場表示・操作）はこのファイルの値に依存してよいが、
 * 逆にロジック側へ色や寸法をコピーしない。
 */
export const GREYBOX = {
  /** 無地の色。確定した配色ではない。 */
  color: {
    sky: 0x1b1c1e,
    fog: 0x1b1c1e,
    floor: 0x3a3b3d,
    wall: 0x2e2f31,
    stallImport: 0x6f7174,
    stallExport: 0x54565a,
    counter: 0x86888c,
    highlight: 0xb9bcc0,
  },
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
  camera: { fov: 70, near: 0.1, far: 220 },
  fog: { near: 18, far: 120 },
} as const;
