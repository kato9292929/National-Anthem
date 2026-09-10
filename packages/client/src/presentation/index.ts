import * as THREE from 'three';
import type { PresentationConfig, RenderMode } from '@na/shared';
import { createMaterialSet, type MaterialSet } from './materials.js';
import { PostPipeline } from './pipeline.js';

/**
 * presentation 層の入口。
 * - マテリアル（要素種別ごとのスロット）とポスプロを 1 本にまとめる。
 * - greybox と stylized をトグルで切り替える（greybox は消さない）。
 * - フレーム予算を超えたら隠さずに知らせる。
 */

/** 平均を出す窓。短すぎるとぶれ、長すぎるとモード切替の反映が遅れる。 */
const SAMPLE_WINDOW = 30;

export interface PresentationLayerOptions {
  config: PresentationConfig;
  renderer: THREE.WebGLRenderer;
  mode: RenderMode;
  /** 予算超過を画面に出すための口。 */
  onBudgetExceeded: (message: string) => void;
  headless?: boolean;
}

export interface FrameStats {
  averageMs: number;
  budgetMs: number;
  exceeded: boolean;
}

export class PresentationLayer {
  private currentMode: RenderMode;
  private materialSet: MaterialSet;
  private readonly pipeline: PostPipeline;
  private readonly samples: number[] = [];
  private averageMs = 0;
  private exceeded = false;
  private warned = false;
  /**
   * ポスプロを一時的に止める。環境メッシュ（ur.glb・Blender の仕上がり）を出している間に使う。
   * stylized のポスプロは greybox の自己発光シェーダ向けに調整してあり、PBR の環境に掛けると
   * 白飛び／黒潰れする（切り分けで確認）。基準画像どおり素の暖色で出すため素通しにする。
   */
  private postSuppressed = false;

  constructor(private readonly options: PresentationLayerOptions) {
    this.currentMode = options.mode;
    this.materialSet = createMaterialSet(options.config, this.currentMode);
    this.pipeline = new PostPipeline(options.renderer, options.config);
  }

  get mode(): RenderMode {
    return this.currentMode;
  }

  get materials(): MaterialSet {
    return this.materialSet;
  }

  /** いま実際に走っているパス。掛からないモードでは空。 */
  get passIds(): string[] {
    return this.postprocessActive ? this.pipeline.passIds : [];
  }

  get postprocessActive(): boolean {
    return (
      !this.postSuppressed &&
      this.pipeline.active &&
      this.options.config.postprocess.appliesTo.includes(this.currentMode)
    );
  }

  /** ポスプロの素通しを切り替える（環境メッシュ表示中に使う）。 */
  setPostSuppressed(suppressed: boolean): void {
    if (this.postSuppressed === suppressed) return;
    this.postSuppressed = suppressed;
    this.resetBudget();
  }

  get isPostSuppressed(): boolean {
    return this.postSuppressed;
  }

  get budgetMs(): number {
    return this.options.headless
      ? this.options.config.performance.headlessFrameBudgetMs
      : this.options.config.performance.frameBudgetMs;
  }

  stats(): FrameStats {
    return { averageMs: this.averageMs, budgetMs: this.budgetMs, exceeded: this.exceeded };
  }

  /**
   * モードを切り替える。マテリアルは作り直すので、呼び出し側でシーンに差し直す。
   * greybox 経路は常に残す（比較・デバッグ用）。
   */
  swapMode(mode: RenderMode): MaterialSet {
    if (mode === this.currentMode) return this.materialSet;
    const previous = this.materialSet;
    this.currentMode = mode;
    this.materialSet = createMaterialSet(this.options.config, mode);
    previous.dispose();
    this.resetBudget();
    return this.materialSet;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, elapsedSeconds: number, frameMs: number): void {
    if (this.postprocessActive) {
      this.pipeline.render(scene, camera, elapsedSeconds);
    } else {
      // 掛からないモードでは素のまま描く（greybox 経路の比較用）。
      this.options.renderer.setRenderTarget(null);
      this.options.renderer.render(scene, camera);
    }
    this.track(frameMs);
  }

  setSize(width: number, height: number): void {
    this.pipeline.setSize(width, height);
  }

  dispose(): void {
    this.pipeline.dispose();
    this.materialSet.dispose();
  }

  private resetBudget(): void {
    this.samples.length = 0;
    // 前のモードの数字を残さない（切り替え直後は「計測中」に戻す）。
    this.averageMs = 0;
    this.exceeded = false;
    this.warned = false;
  }

  /** 予算超過は握りつぶさない。画面とログの両方に出す。 */
  private track(frameMs: number): void {
    this.samples.push(frameMs);
    if (this.samples.length < SAMPLE_WINDOW) return;
    this.averageMs = this.samples.reduce((sum, v) => sum + v, 0) / this.samples.length;
    this.samples.length = 0;

    const budget = this.budgetMs;
    this.exceeded = this.averageMs > budget;
    if (this.exceeded && !this.warned) {
      this.warned = true;
      const message =
        `フレーム予算を超えている: ${this.averageMs.toFixed(1)}ms > ${budget}ms` +
        `（mode=${this.currentMode} / passes=${this.passIds.join(',') || 'なし'}）`;
      console.error(`[presentation] ${message}`);
      this.options.onBudgetExceeded(message);
    }
    if (!this.exceeded) this.warned = false;
  }
}

export { createMaterialSet, stallMaterial, type MaterialSet } from './materials.js';
export { fetchPresentationConfig, initialMode, unconfirmedList } from './config.js';
