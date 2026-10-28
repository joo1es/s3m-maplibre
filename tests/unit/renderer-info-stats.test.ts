/**
 * 单元测试：renderer.info 进 Stats（GPU 预算观测）
 *
 * 动机：优化前必须先能测量。Stats 原来只有 tiles/meshes/vertices/triangles，
 * 看不到 draw call、已编译 program 数与显存驻留——这正是判断「要不要合批 /
 * 会不会超预算」的关键指标。
 *
 * 不依赖 WebGL：渲染器用桩替身，只验证取值与兜底。
 */
import { describe, expect, test } from 'bun:test';
import { S3MViewer } from '../../packages/s3m-three/src/render/S3MViewer';

function makeViewer(): S3MViewer {
  return new S3MViewer({ canvas: null as never, container: null as never } as ConstructorParameters<typeof S3MViewer>[0]);
}

describe('renderer.info 进 Stats', () => {
  test('无渲染器（未 mount）时新字段为 0，不抛错', () => {
    const v = makeViewer();
    const s = v.stats;
    expect(s.drawCalls).toBe(0);
    expect(s.programs).toBe(0);
    expect(s.textures).toBe(0);
    expect(s.geometries).toBe(0);
    // 旧字段原样保留
    expect(s.tiles).toBe(0);
    expect(s.datasets).toBe(0);
    v.dispose();
  });

  test('有渲染器时从 renderer.info 取值', () => {
    const v = makeViewer();
    (v as unknown as { renderer: unknown }).renderer = {
      info: {
        render: { calls: 42 },
        programs: [{}, {}, {}],
        memory: { textures: 7, geometries: 9 },
      },
    };
    const s = v.stats;
    expect(s.drawCalls).toBe(42);
    expect(s.programs).toBe(3);
    expect(s.textures).toBe(7);
    expect(s.geometries).toBe(9);
    v.dispose();
  });

  test('programs 为 null（renderer 尚未使用）时兜底为 0', () => {
    const v = makeViewer();
    (v as unknown as { renderer: unknown }).renderer = {
      info: { render: { calls: 0 }, programs: null, memory: { textures: 0, geometries: 0 } },
    };
    expect(v.stats.programs).toBe(0);
    v.dispose();
  });
});
