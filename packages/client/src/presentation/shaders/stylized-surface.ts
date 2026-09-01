/**
 * stylized の面シェーダ。
 * パラメータはすべて config から差す。既定はニュートラル（0 = 効果なし）。
 * 色そのものはここに書かない（uniform で受ける）。
 */

export const STYLIZED_SURFACE_VERTEX = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vPositionW;
  varying vec3 vViewDir;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vPositionW = world.xyz;
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const STYLIZED_SURFACE_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec3 uColor;
  uniform vec3 uTintColor;
  uniform vec3 uLightDir;
  uniform float uAmbient;
  uniform float uBands;
  uniform float uRim;
  uniform float uWarp;
  uniform float uTint;

  varying vec3 vNormalW;
  varying vec3 vPositionW;
  varying vec3 vViewDir;

  void main() {
    vec3 n = normalize(vNormalW);
    float ndl = max(dot(n, normalize(uLightDir)), 0.0);
    float lit = uAmbient + (1.0 - uAmbient) * ndl;

    // 手描きの揺らぎ。0 のときは何もしない。
    if (uWarp > 0.0) {
      float wobble = sin(vPositionW.x * 3.1) * sin(vPositionW.z * 2.7) * sin(vPositionW.y * 1.9);
      lit += wobble * uWarp;
    }

    // 階調の量子化。2 未満なら量子化しない。
    if (uBands >= 2.0) {
      lit = floor(clamp(lit, 0.0, 1.0) * uBands) / max(uBands - 1.0, 1.0);
    }
    lit = clamp(lit, 0.0, 1.0);

    vec3 base = uColor * lit;

    if (uRim > 0.0) {
      float rim = pow(1.0 - max(dot(n, normalize(vViewDir)), 0.0), 2.0);
      base += uTintColor * rim * uRim;
    }
    if (uTint > 0.0) {
      base = mix(base, uTintColor, uTint);
    }

    gl_FragColor = vec4(base, 1.0);
  }
`;
