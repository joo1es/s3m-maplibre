/**
 * 着色模式变体预热的单测（smart-city 卡顿专项 · C）。
 *
 * 要钉住的三条：
 * 1. 没挂载 / 没材质时不抛（预热是可选优化，不能成为新的失败点）；
 * 2. 预热完把**原来的模式还原**——否则演出一开始就停在最后一个热身模式上；
 * 3. 每换一个模式都要重新放行「已预热」闸门，否则第二次以后全是空操作
 *    （`prewarmShading` 内部只热一次）。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';
import { STYLE } from '../../packages/s3m-three/src/render/StyleMaterial';

describe('prewarmStyleVariants', () => {
  test('未挂载时安全返回，不抛', async () => {
    const v = new S3MViewer({} as any);
    await expect(v.prewarmStyleVariants([STYLE.HEIGHT])).resolves.toBeUndefined();
  });

  test('没有材质时不抛（prewarmShading 自己会空转）', async () => {
    const v = new S3MViewer({} as any);
    let compiled = 0;
    (v as any).renderer = { compileAsync: async () => { compiled++; } };
    (v as any).scene = new THREE.Scene();
    (v as any).camera = new THREE.Camera();
    await v.prewarmStyleVariants([STYLE.HEIGHT, STYLE.DYNAMIC]);
    // 场上没有 styled 材质 → 不该有编译动作，但也不能报错
    expect(compiled).toBe(0);
  });

  test('预热结束后模式还原成调用前的那个', async () => {
    const v = new S3MViewer({} as any);
    (v as any).renderer = { compileAsync: async () => {} };
    (v as any).scene = new THREE.Scene();
    (v as any).camera = new THREE.Camera();
    v.setStyle({ mode: STYLE.TEXTURE }, { duration: 0 });

    await v.prewarmStyleVariants([STYLE.HEIGHT, STYLE.DYNAMIC, STYLE.CUSTOM]);

    expect(v.style.mode).toBe(STYLE.TEXTURE);
  });

  test('候选里包含当前模式时也不留在它上面', async () => {
    const v = new S3MViewer({} as any);
    (v as any).renderer = { compileAsync: async () => {} };
    (v as any).scene = new THREE.Scene();
    (v as any).camera = new THREE.Camera();
    v.setStyle({ mode: STYLE.HEIGHT }, { duration: 0 });

    await v.prewarmStyleVariants([STYLE.HEIGHT, STYLE.DYNAMIC]);
    expect(v.style.mode).toBe(STYLE.HEIGHT);
  });

  test('预热期间的渲染被跳过（避免把翻转变体画到屏幕上）', async () => {
    const v = new S3MViewer({} as any);
    (v as any).renderer = { compileAsync: async () => {} };
    (v as any).scene = new THREE.Scene();
    (v as any).camera = new THREE.Camera();
    v.setStyle({ mode: STYLE.TEXTURE }, { duration: 0 });

    const seen: boolean[] = [];
    const origSetStyle = v.setStyle.bind(v);
    (v as any).setStyle = (patch: any, t: any) => {
      seen.push((v as any)._prewarming === true);
      origSetStyle(patch, t);
    };

    await v.prewarmStyleVariants([STYLE.HEIGHT, STYLE.DYNAMIC]);
    expect(seen.every(Boolean)).toBe(true);
    // 结束后必须复位，否则之后永远不渲染
    expect((v as any)._prewarming).toBe(false);
  });
});

describe('S3MLayer.prewarmStyleVariants 透传', () => {
  test('图层方法存在且转发给内核', async () => {
    const { S3MLayer } = await import('../../packages/s3m-maplibre/src/S3MLayer');
    const layer = new S3MLayer({ id: 'x' } as any);
    let called: unknown = null;
    (layer.viewer as any).prewarmStyleVariants = async (m: unknown) => {
      called = m;
    };
    await layer.prewarmStyleVariants([STYLE.HEIGHT]);
    expect(called).toEqual([STYLE.HEIGHT]);
  });
});

describe('program 首次编译的入队时机', () => {
  /**
   * 新瓦片可能带来新的材质变体，program 是第一次用到才同步编译的。
   * 原先靠 stats 每 15 帧轮询 mesh 数，最坏要等 ~250ms 才发现；
   * 现在瓦片一落地就置 `_compilePending`，下一帧就能发起 compileAsync。
   */
  test('瓦片落地立刻标记待编译（不再等 15 帧轮询）', () => {
    const v = new S3MViewer({} as any);
    expect((v as any)._compilePending).toBe(false);

    const entry = (v as any)._datasetManager.registerDataset({ id: 't' });
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    group.add(mesh);

    (v as any)._registerTile({ group, tile: null, sphere: null }, entry);
    expect((v as any)._compilePending).toBe(true);
  });
});
