import * as THREE from 'three';
import type { PostPassConfig, PresentationConfig } from '@na/shared';
import { param } from './config.js';
import { PASSES, PASS_VERTEX, uniformName } from './passes.js';

/**
 * ポストプロセスの合成器。
 * 有効なパスを config の順に積む。1 本も無ければシーンを直接描く（余計な往復をしない）。
 * パスの種別・順序・強度は config が決める。ここで見た目を決め打ちしない。
 */

interface BuiltPass {
  id: string;
  material: THREE.ShaderMaterial;
  usesTime: boolean;
}

export class PostPipeline {
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private built: BuiltPass[] = [];

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    config: PresentationConfig,
  ) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quadScene.add(this.quad);
    this.rebuild(config);
  }

  /** config を差し替えたら、この 1 本を組み直すだけで見た目が変わる。 */
  rebuild(config: PresentationConfig): void {
    this.disposePasses();
    if (!config.postprocess.enabled) {
      this.built = [];
      return;
    }
    this.built = config.postprocess.passes
      .filter((pass) => pass.enabled && pass.strength > 0)
      .map((pass) => this.buildPass(pass));
  }

  get passIds(): string[] {
    return this.built.map((pass) => pass.id);
  }

  get active(): boolean {
    return this.built.length > 0;
  }

  setSize(width: number, height: number): void {
    if (!this.targets) return;
    for (const target of this.targets) target.setSize(width, height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, elapsedSeconds: number): void {
    if (this.built.length === 0) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const targets = this.ensureTargets(size.x, size.y);

    this.renderer.setRenderTarget(targets[0]);
    this.renderer.render(scene, camera);

    let readIndex = 0;
    for (const [index, pass] of this.built.entries()) {
      const isLast = index === this.built.length - 1;
      const write = targets[readIndex === 0 ? 1 : 0];
      pass.material.uniforms['uTexture']!.value = targets[readIndex]!.texture;
      pass.material.uniforms['uResolution']!.value.set(size.x, size.y);
      if (pass.usesTime) pass.material.uniforms['uTime']!.value = elapsedSeconds;
      this.quad.material = pass.material;
      this.renderer.setRenderTarget(isLast ? null : write);
      this.renderer.render(this.quadScene, this.quadCamera);
      readIndex = readIndex === 0 ? 1 : 0;
    }
    this.renderer.setRenderTarget(null);
  }

  dispose(): void {
    this.disposePasses();
    if (this.targets) for (const target of this.targets) target.dispose();
    this.targets = null;
    this.quad.geometry.dispose();
  }

  private ensureTargets(width: number, height: number): [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] {
    if (!this.targets) {
      const make = (): THREE.WebGLRenderTarget =>
        new THREE.WebGLRenderTarget(width, height, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: true,
        });
      this.targets = [make(), make()];
    } else if (this.targets[0].width !== width || this.targets[0].height !== height) {
      for (const target of this.targets) target.setSize(width, height);
    }
    return this.targets;
  }

  private buildPass(pass: PostPassConfig): BuiltPass {
    const definition = PASSES[pass.id];
    const uniforms: Record<string, THREE.IUniform> = {
      uTexture: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uStrength: { value: pass.strength },
      uTime: { value: 0 },
    };
    for (const key of definition.paramKeys) {
      uniforms[uniformName(key)] = { value: param(pass.params, key, `postprocess.passes(${pass.id}).params`) };
    }
    return {
      id: pass.id,
      usesTime: definition.usesTime,
      material: new THREE.ShaderMaterial({
        vertexShader: PASS_VERTEX,
        fragmentShader: definition.fragment,
        uniforms,
        depthTest: false,
        depthWrite: false,
      }),
    };
  }

  private disposePasses(): void {
    for (const pass of this.built) pass.material.dispose();
    this.built = [];
  }
}
