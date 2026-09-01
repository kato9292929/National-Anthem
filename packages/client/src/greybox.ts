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
  /** 内側の区画（standing で開閉する門）。 */
  gate: {
    partitionOffsetZ: 6,
    doorWidth: 2.2,
    doorHeight: 3.2,
    thickness: 0.45,
    labelHeight: 3.9,
    colorClosed: 0x7a6f5c,
    colorOpenMarker: 0x5c6f7a,
  },
  /** 照明。グレイボックス段階の無地の当て方。 */
  light: { sky: 0xffffff, ground: 0x404040, ambientIntensity: 1.15, keyColor: 0xffffff, keyIntensity: 0.55 },
  /** 看板に描く文字と枠の色。canvas に直接書くのでここに集める。 */
  label: {
    background: 'rgba(20,21,23,0.86)',
    border: '#6a6d72',
    borderShock: '#d9c48a',
    borderOpen: '#9fd39f',
    borderClosed: '#a38f5c',
    title: '#e6e7e9',
    body: '#b9bcc0',
    open: '#9fd39f',
    closed: '#d9c48a',
  },
  camera: { fov: 70, near: 0.1, far: 220 },
  fog: { near: 18, far: 120 },
} as const;
