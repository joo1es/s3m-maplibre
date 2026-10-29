import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import {
  DEFAULT_FLOOR_HEIGHT,
  buildAttributes,
  buildInstanceLookup,
  measureSegments,
  pickEntryId,
  resolveFeature,
} from '../../packages/s3m-three/src/core/FeatureInfo.js';
import type { GeoPackageEntry, PickEntry } from '../../packages/s3m-three/src/core/types.js';

describe('FeatureInfo', () => {
  describe('pickEntryId', () => {
    it('null 或 undefined 返回 -1', () => {
      expect(pickEntryId(null)).toBe(-1);
      expect(pickEntryId(undefined)).toBe(-1);
    });

    it('优先返回 batchId', () => {
      expect(pickEntryId({ batchId: 42, instanceBatchId: 10 } as PickEntry)).toBe(42);
      expect(pickEntryId({ batchId: 0 } as PickEntry)).toBe(0);
    });

    it('无 batchId 时退回 instanceBatchId', () => {
      expect(pickEntryId({ instanceBatchId: 15 } as PickEntry)).toBe(15);
    });

    it('两者皆无时返回 -1', () => {
      expect(pickEntryId({} as PickEntry)).toBe(-1);
    });
  });

  describe('buildInstanceLookup', () => {
    it('null 或空对象返回空 Map', () => {
      expect(buildInstanceLookup(null).size).toBe(0);
      expect(buildInstanceLookup(undefined).size).toBe(0);
      expect(buildInstanceLookup({}).size).toBe(0);
    });

    it('正确建立 instanceId 到 smid 和 batchId 的映射', () => {
      const pickInfo: Record<number, PickEntry> = {
        1001: {
          instanceBatchId: 5,
          instanceIds: [0, 1, 2],
        },
        1002: {
          batchId: 8,
          instanceIds: [3],
        },
      };

      const map = buildInstanceLookup(pickInfo);
      expect(map.size).toBe(4);
      expect(map.get(0)).toEqual({ smid: 1001, batchId: 5 });
      expect(map.get(1)).toEqual({ smid: 1001, batchId: 5 });
      expect(map.get(2)).toEqual({ smid: 1001, batchId: 5 });
      expect(map.get(3)).toEqual({ smid: 1002, batchId: 8 });
    });

    it('忽略无 instanceIds 或非法 smid 的项', () => {
      const pickInfo = {
        abc: { instanceIds: [1] },
        1003: { instanceIds: [] },
        1004: null,
      } as unknown as Record<number, PickEntry>;

      const map = buildInstanceLookup(pickInfo);
      expect(map.size).toBe(0);
    });
  });

  describe('resolveFeature', () => {
    it('geo 为空或 batchId < 0 时返回 null', () => {
      expect(resolveFeature(undefined, 0)).toEqual({ smid: null, segments: [] });
      expect(resolveFeature({} as GeoPackageEntry, -1)).toEqual({ smid: null, segments: [] });
    });

    it('根据 batchId 正确反查 smid 和 segments', () => {
      const geo: GeoPackageEntry = {
        pickInfo: {
          101: {
            batchId: 2,
            segments: [{ vertexOffset: 0, vertexCount: 12 }],
          },
          102: {
            batchId: 3,
            segments: [{ vertexOffset: 12, vertexCount: 6 }],
          },
        },
      } as unknown as GeoPackageEntry;

      const res = resolveFeature(geo, 3);
      expect(res.smid).toBe(102);
      expect(res.segments).toEqual([{ vertexOffset: 12, vertexCount: 6 }]);
    });

    it('未找到 batchId 时返回 null smid', () => {
      const geo: GeoPackageEntry = {
        pickInfo: {
          101: { batchId: 2 },
        },
      } as unknown as GeoPackageEntry;

      expect(resolveFeature(geo, 99)).toEqual({ smid: null, segments: [] });
    });
  });

  describe('measureSegments', () => {
    it('无 position 属性或 segments 为空时返回 null', () => {
      expect(measureSegments(undefined, [{ vertexOffset: 0, vertexCount: 3 }])).toBeNull();
      const geom = new THREE.BufferGeometry();
      expect(measureSegments(geom, [{ vertexOffset: 0, vertexCount: 3 }])).toBeNull();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
      expect(measureSegments(geom, [])).toBeNull();
    });

    it('计算顶点范围包围盒并统计顶点数', () => {
      const geom = new THREE.BufferGeometry();
      // 4 个顶点: (0,0,10), (10,0,10), (10,20,10), (0,20,30)
      const positions = new Float32Array([
        0, 0, 10,
        10, 0, 10,
        10, 20, 10,
        0, 20, 30,
      ]);
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      const segments = [
        { vertexOffset: 0, vertexCount: 2 },
        { vertexOffset: 2, vertexCount: 2 },
      ];

      const box = measureSegments(geom, segments);
      expect(box).not.toBeNull();
      expect(box!.minX).toBe(0);
      expect(box!.maxX).toBe(10);
      expect(box!.minY).toBe(0);
      expect(box!.maxY).toBe(20);
      expect(box!.minZ).toBe(10);
      expect(box!.maxZ).toBe(30);
      expect(box!.count).toBe(4);
    });

    it('正确按 mask 统计单体专属三角面数（跨区间的三角形不计入）', () => {
      const geom = new THREE.BufferGeometry();
      // 5 个顶点: 0, 1, 2 属于单体 A，3, 4 属于单体 B
      const positions = new Float32Array(5 * 3);
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      // 索引：
      // 三角形 1: [0, 1, 2] -> 都在 A 内 -> 计入
      // 三角形 2: [1, 2, 3] -> 跨 A 和 B -> 不计入
      geom.setIndex([0, 1, 2, 1, 2, 3]);

      const segmentsA = [{ vertexOffset: 0, vertexCount: 3 }];
      const box = measureSegments(geom, segmentsA);
      expect(box).not.toBeNull();
      expect(box!.triangles).toBe(1);
    });
  });

  describe('buildAttributes', () => {
    it('无 box 时直接返回 smid 和 triangles', () => {
      const attrs = buildAttributes({ smid: 123, box: null, triangles: 10 });
      expect(attrs).toEqual({ smid: 123, triangles: 10 });
    });

    it('根据 box 完整计算高度、底高程、尺寸、面积、楼层与外接盒', () => {
      const box = {
        minX: 10.04,
        maxX: 30.06,
        minY: 5.02,
        maxY: 25.04,
        minZ: 100.12,
        maxZ: 132.18,
        count: 50,
        triangles: 24,
      };

      const attrs = buildAttributes({
        smid: 456,
        box,
        triangles: 0,
      });

      expect(attrs.smid).toBe(456);
      expect(attrs.height).toBe(32.1); // 132.18 - 100.12 = 32.06 -> 32.1
      expect(attrs.baseElevation).toBe(100.1);
      expect(attrs.size).toEqual([20, 20]); // 30.06 - 10.04 = 20.02 -> 20.0
      expect(attrs.bboxArea).toBe(400.8); // 20.02 * 20.02 = 400.8004 -> 400.8
      expect(attrs.vertices).toBe(50);
      expect(attrs.triangles).toBe(24);
      // 默认层高 3.2米: 32.06 / 3.2 = 10.01875 -> 10 层
      expect(attrs.floors).toBe(10);
      expect(attrs.bbox).toEqual([
        [10, 5, 100.1],
        [30.1, 25, 132.2],
      ]);
    });

    it('支持自定义 floorHeight 且楼层至少为 1', () => {
      const box = {
        minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1.5,
        count: 4, triangles: 2,
      };

      const attrs = buildAttributes({
        smid: 789,
        box,
        triangles: 2,
        floorHeight: 5.0,
      });

      // 1.5 / 5.0 = 0.3 -> round 为 0，Math.max(1, 0) 保证至少 1 层
      expect(attrs.floors).toBe(1);
    });
  });
});
