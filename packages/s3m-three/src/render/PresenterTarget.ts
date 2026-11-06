/**
 * 使用者接管「场景 → 屏幕」这一步的载体（`viewer.setPresenter()` 的实现）。
 *
 * 动机：本库画在宿主的 framebuffer 上（MapLibre custom layer），想对 S3M 的画面
 * 做后处理，就必须先让场景进自己的 RT，再自己合成回屏幕。缺了这一步，使用者只剩
 * `copyTexImage2D` 拷画布这条路 —— 拿到的是「底图 + S3M」的合成结果，而且**没有深度**，
 * SSAO / 景深 / 雾这类依赖深度的效果全都做不了，而那恰恰是本库唯一不可替代的部分。
 *
 * 这个类只做三件事，不做效果、不排队、不管顺序：
 *   1. 按画布尺寸建 / 重建 color + depth 的 RT；
 *   2. 把场景渲进去（线性空间、透明底、premultiplied）；
 *   3. 把两张纹理交出去，之后怎么画、画几趟，全由 presenter 决定。
 *
 * 不在这里做合成，是刻意的：一旦框架替使用者合成，就得定义「多个 presenter
 * 谁先谁后、混合怎么做」，那就从「开个口子」变成「造一套框架」。现在这个边界是
 * 「设了就独占上屏」，叠加效果由使用者自己在 render 里串。
 */
import * as THREE from 'three';

/** presenter 每帧拿到的上下文。只读，不要 dispose 其中的纹理 */
export interface PresenterContext {
  renderer: THREE.WebGLRenderer;
  /** 本帧的场景与相机（已按宿主矩阵就位），可直接再渲一遍做第二个 pass */
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** 绘图缓冲尺寸（像素），不是 CSS 尺寸 */
  width: number;
  height: number;
  /** 本帧场景已渲好的颜色纹理：线性空间、透明底、premultiplied */
  color: THREE.Texture;
  /** 与 color 同尺寸的深度纹理。合成时务必用它写回 gl_FragDepth，否则后画的宿主图层挡不住 S3M */
  depth: THREE.DepthTexture;
}

/** 接管上屏的钩子。实现方必须自己把结果画到屏幕（`renderer.setRenderTarget(null)` 后绘制） */
export interface ViewerPresenter {
  render(ctx: PresenterContext): void;
}

export class PresenterTarget {
  private _rt: THREE.WebGLRenderTarget | null = null;
  private _w = 0;
  private _h = 0;
  private _warned = false;

  /** 当前 RT（没建过为 null）。给测试与排查用，不要拿去 dispose */
  get target(): THREE.WebGLRenderTarget | null {
    return this._rt;
  }

  get width(): number {
    return this._w;
  }

  get height(): number {
    return this._h;
  }

  /**
   * WebGL2 才有 DepthTexture。这把闸门和 MotionBlurPass 是同一条：
   * 不支持时返回 false，调用方回退直渲，画面与没设 presenter 完全一致。
   */
  supported(renderer: THREE.WebGLRenderer): boolean {
    return (renderer.capabilities as { isWebGL2?: boolean }).isWebGL2 === true;
  }

  /**
   * 场景 → RT → 交给 presenter。
   *
   * @returns 是否真的走了这条路径。false（尺寸非法 / WebGL1）时调用方必须回退直渲，
   *          否则这一帧什么都不画，屏幕停在上一个画面。
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
    presenter: ViewerPresenter
  ): boolean {
    if (!(width > 0) || !(height > 0)) return false;
    if (!this.supported(renderer)) {
      if (!this._warned) {
        this._warned = true;
        console.warn('[s3m] setPresenter 需要 WebGL2（DepthTexture），当前环境不支持，本帧回退直渲');
      }
      return false;
    }

    this._ensure(width, height);
    const rt = this._rt;
    if (!rt || !rt.depthTexture) return false;

    // 宿主没让我们改清屏色，改完必须还原 —— 这一帧之后还有别的图层要画
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(rt);
    renderer.setViewport(0, 0, rt.width, rt.height);
    // 透明底：S3M 之外的像素（天空）alpha = 0，presenter 才好判断哪里该 discard
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.setClearColor(prevColor, prevAlpha);

    presenter.render({
      renderer,
      scene,
      camera,
      width: rt.width,
      height: rt.height,
      color: rt.texture,
      depth: rt.depthTexture,
    });

    // 交给使用者的收尾：three 的状态缓存与 GL 绑定可能已被他绕过（raw gl 调用），
    // 后面还有 GPU 描边要画，这里统一拉回「屏幕 + 默认状态」。
    // 注意这不负责清屏，使用者已经画上去的像素不受影响。
    renderer.resetState();
    return true;
  }

  private _ensure(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this._rt && this._w === w && this._h === h) return;

    this.dispose();
    // HalfFloat：RT 里存 tone map 之前的线性值，UnsignedByte 会把高光 clamp 到 1，
    // presenter 做完再映射回来就过曝了。代价是显存与带宽 ×2，与 motionBlur 同一取舍。
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.generateMipmaps = false;
    rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    this._rt = rt;
    this._w = w;
    this._h = h;
  }

  /** 释放 RT。resize / unmount / restoreContext 都会走这里，下一帧按需重建 */
  dispose(): void {
    const rt = this._rt;
    this._rt = null;
    this._w = 0;
    this._h = 0;
    if (!rt) return;
    rt.depthTexture?.dispose();
    rt.dispose();
  }
}
