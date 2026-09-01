import type { PostPassId } from '@na/shared';

/**
 * ポスプロのパス。
 * どれを使うか・どの順で積むか・強度は config が決める。ここでは種別ごとの中身だけを持つ。
 * 強度 0 のときは入力をそのまま返す（ニュートラル既定で素の絵と同じになる）。
 */

export interface PassDefinition {
  id: PostPassId;
  fragment: string;
  /** config の params から uniform に渡すキー。欠けていたら落とす。 */
  paramKeys: string[];
  /** 時間 uniform を使うか。 */
  usesTime: boolean;
}

const HEADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uTexture;
  uniform vec2 uResolution;
  uniform float uStrength;
  uniform float uTime;
  varying vec2 vUv;
`;

export const PASSES: Record<PostPassId, PassDefinition> = {
  tonemap: {
    id: 'tonemap',
    paramKeys: ['exposure'],
    usesTime: false,
    fragment: `${HEADER}
      uniform float uExposure;
      void main() {
        vec3 src = texture2D(uTexture, vUv).rgb;
        vec3 exposed = src * uExposure;
        vec3 mapped = exposed / (exposed + vec3(1.0));
        gl_FragColor = vec4(mix(src, mapped, uStrength), 1.0);
      }
    `,
  },
  posterize: {
    id: 'posterize',
    paramKeys: ['steps'],
    usesTime: false,
    fragment: `${HEADER}
      uniform float uSteps;
      void main() {
        vec3 src = texture2D(uTexture, vUv).rgb;
        float steps = max(uSteps, 2.0);
        vec3 quantized = floor(src * steps) / (steps - 1.0);
        gl_FragColor = vec4(mix(src, clamp(quantized, 0.0, 1.0), uStrength), 1.0);
      }
    `,
  },
  dither: {
    id: 'dither',
    paramKeys: ['scale'],
    usesTime: false,
    fragment: `${HEADER}
      uniform float uScale;
      float bayer(vec2 p) {
        // 4x4 の順序ディザ。
        int x = int(mod(p.x, 4.0));
        int y = int(mod(p.y, 4.0));
        int index = x + y * 4;
        float table[16];
        table[0]=0.0; table[1]=8.0; table[2]=2.0; table[3]=10.0;
        table[4]=12.0; table[5]=4.0; table[6]=14.0; table[7]=6.0;
        table[8]=3.0; table[9]=11.0; table[10]=1.0; table[11]=9.0;
        table[12]=15.0; table[13]=7.0; table[14]=13.0; table[15]=5.0;
        for (int i = 0; i < 16; i++) {
          if (i == index) return table[i] / 16.0;
        }
        return 0.0;
      }
      void main() {
        vec3 src = texture2D(uTexture, vUv).rgb;
        float scale = max(uScale, 1.0);
        float threshold = bayer(gl_FragCoord.xy / scale) - 0.5;
        vec3 dithered = clamp(src + threshold * 0.25, 0.0, 1.0);
        gl_FragColor = vec4(mix(src, dithered, uStrength), 1.0);
      }
    `,
  },
  outline: {
    id: 'outline',
    paramKeys: ['threshold'],
    usesTime: false,
    fragment: `${HEADER}
      uniform float uThreshold;
      float luma(vec2 uv) {
        vec3 c = texture2D(uTexture, uv).rgb;
        return dot(c, vec3(0.299, 0.587, 0.114));
      }
      void main() {
        vec3 src = texture2D(uTexture, vUv).rgb;
        vec2 texel = 1.0 / uResolution;
        float gx =
          -luma(vUv + texel * vec2(-1.0, -1.0)) - 2.0 * luma(vUv + texel * vec2(-1.0, 0.0)) - luma(vUv + texel * vec2(-1.0, 1.0)) +
           luma(vUv + texel * vec2( 1.0, -1.0)) + 2.0 * luma(vUv + texel * vec2( 1.0, 0.0)) + luma(vUv + texel * vec2( 1.0, 1.0));
        float gy =
          -luma(vUv + texel * vec2(-1.0, -1.0)) - 2.0 * luma(vUv + texel * vec2(0.0, -1.0)) - luma(vUv + texel * vec2(1.0, -1.0)) +
           luma(vUv + texel * vec2(-1.0,  1.0)) + 2.0 * luma(vUv + texel * vec2(0.0,  1.0)) + luma(vUv + texel * vec2(1.0,  1.0));
        float edge = step(uThreshold, sqrt(gx * gx + gy * gy));
        gl_FragColor = vec4(mix(src, src * (1.0 - edge), uStrength), 1.0);
      }
    `,
  },
  grain: {
    id: 'grain',
    paramKeys: ['scale', 'speed'],
    usesTime: true,
    fragment: `${HEADER}
      uniform float uScale;
      uniform float uSpeed;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      void main() {
        vec3 src = texture2D(uTexture, vUv).rgb;
        vec2 p = gl_FragCoord.xy / max(uScale, 1.0) + uTime * uSpeed;
        float n = hash(floor(p)) - 0.5;
        gl_FragColor = vec4(clamp(src + n * uStrength, 0.0, 1.0), 1.0);
      }
    `,
  },
  colorGrade: {
    id: 'colorGrade',
    paramKeys: ['shadowShift', 'highlightShift'],
    usesTime: false,
    fragment: `${HEADER}
      uniform float uShadowShift;
      uniform float uHighlightShift;
      void main() {
        vec3 src = texture2D(uTexture, vUv).rgb;
        float l = dot(src, vec3(0.299, 0.587, 0.114));
        vec3 graded = src;
        graded.b += (1.0 - l) * uShadowShift;
        graded.r += l * uHighlightShift;
        gl_FragColor = vec4(mix(src, clamp(graded, 0.0, 1.0), uStrength), 1.0);
      }
    `,
  },
};

export const PASS_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** config の params キーから uniform 名を作る（shadowShift -> uShadowShift）。 */
export function uniformName(key: string): string {
  return `u${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}
