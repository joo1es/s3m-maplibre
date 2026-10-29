import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import {
  FeatureStyleManager,
  extractEulerAngles,
  resolveRotationMatrix,
} from '../../packages/s3m-three/src/render/FeatureStyleManager.js';

describe('FeatureStyleManager 批次冲突审计与旋转解析', () => {
  describe('auditBatches', () => {
    it('无 pickInfo 或无冲突时返回空 conflict 列表', () => {
      const manager = new FeatureStyleManager(
        () => 3.2,
        () => {},
        () => {}
      );

      const mEmpty = new THREE.Mesh();
      const mSingle = new THREE.Mesh();
      mSingle.userData = {
        geoRef: {
          pickInfo: {
            101: { batchId: 0 },
            102: { batchId: 1 },
          },
        },
      };

      const audit = manager.auditBatches([
        { datasetId: 'd0', mesh: mEmpty },
        { datasetId: 'd1', mesh: mSingle },
      ]);

      expect(audit.batches).toBe(2);
      expect(audit.conflicts.length).toBe(0);
      expect(audit.conflictingSmids).toBe(0);
    });

    it('多 SMID 共用相同 batchId 时正确检测出冲突并统计冲突 SMID 数', () => {
      const manager = new FeatureStyleManager(
        () => 3.2,
        () => {},
        () => {}
      );

      const mConflict = new THREE.Mesh();
      mConflict.userData = {
        geoRef: {
          pickInfo: {
            201: { batchId: 0 },
            202: { batchId: 0 }, // 冲突
            203: { batchId: 1 }, // 独立
          },
        },
      };

      const audit = manager.auditBatches([{ datasetId: 'cbd', mesh: mConflict }]);
      expect(audit.batches).toBe(2);
      expect(audit.conflicts.length).toBe(1);
      expect(audit.conflicts[0]).toEqual({
        datasetId: 'cbd',
        batchId: 0,
        smids: [201, 202],
      });
      expect(audit.conflictingSmids).toBe(2);
    });
  });

  describe('resolveRotationMatrix', () => {
    it('null 或 undefined 返回 null', () => {
      expect(resolveRotationMatrix(null)).toBeNull();
      expect(resolveRotationMatrix(undefined)).toBeNull();
      expect(resolveRotationMatrix({} as any)).toBeNull();
    });

    it('纯数值按绕 Z 轴旋转生成 3x3 矩阵', () => {
      const theta = Math.PI / 2;
      const m = resolveRotationMatrix(theta);
      expect(m).not.toBeNull();
      // cos(pi/2) ~ 0, sin(pi/2) ~ 1
      expect(m![0]).toBeCloseTo(0);
      expect(m![1]).toBeCloseTo(-1);
      expect(m![3]).toBeCloseTo(1);
      expect(m![4]).toBeCloseTo(0);
      expect(m![8]).toBe(1);
    });

    it('支持欧拉角数组 [rx, ry, rz] 与四元数数组 [x, y, z, w]', () => {
      // 欧拉角绕 Z 轴 90度
      const mEuler = resolveRotationMatrix([0, 0, Math.PI / 2]);
      expect(mEuler).not.toBeNull();
      expect(mEuler![0]).toBeCloseTo(0);
      expect(mEuler![1]).toBeCloseTo(-1);

      // 四元数绕 Z 轴 90度 (q = [0, 0, sin(pi/4), cos(pi/4)])
      const s = Math.sin(Math.PI / 4);
      const c = Math.cos(Math.PI / 4);
      const mQuat = resolveRotationMatrix([0, 0, s, c]);
      expect(mQuat).not.toBeNull();
      expect(mQuat![0]).toBeCloseTo(0);
      expect(mQuat![1]).toBeCloseTo(-1);
    });

    it('支持 THREE.Euler, THREE.Quaternion, THREE.Matrix3, THREE.Matrix4', () => {
      const euler = new THREE.Euler(0, 0, Math.PI);
      const m1 = resolveRotationMatrix(euler);
      expect(m1).not.toBeNull();
      expect(m1![0]).toBeCloseTo(-1);

      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
      const m2 = resolveRotationMatrix(quat);
      expect(m2).not.toBeNull();
      expect(m2![0]).toBeCloseTo(-1);

      const mat4 = new THREE.Matrix4().makeRotationZ(Math.PI);
      const m3 = resolveRotationMatrix(mat4);
      expect(m3).not.toBeNull();
      expect(m3![0]).toBeCloseTo(-1);

      const mat3 = new THREE.Matrix3().setFromMatrix4(mat4);
      const m4 = resolveRotationMatrix(mat3);
      expect(m4).not.toBeNull();
      expect(m4![0]).toBeCloseTo(-1);
    });
  });

  describe('extractEulerAngles', () => {
    it('null 或非法输入返回 [0, 0, 0]', () => {
      expect(extractEulerAngles(null)).toEqual([0, 0, 0]);
      expect(extractEulerAngles(undefined)).toEqual([0, 0, 0]);
      expect(extractEulerAngles({} as any)).toEqual([0, 0, 0]);
    });

    it('纯数值映射到 [0, 0, val]', () => {
      expect(extractEulerAngles(1.23)).toEqual([0, 0, 1.23]);
    });

    it('数组与 THREE.Euler 提取欧拉角', () => {
      expect(extractEulerAngles([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
      const e = new THREE.Euler(0.5, 0.6, 0.7);
      expect(extractEulerAngles(e)).toEqual([0.5, 0.6, 0.7]);
    });

    it('从四元数与旋转矩阵正确提取欧拉角', () => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
      const [rx, ry, rz] = extractEulerAngles(q);
      expect(rx).toBeCloseTo(0);
      expect(ry).toBeCloseTo(0);
      expect(rz).toBeCloseTo(0.5);

      const m4 = new THREE.Matrix4().makeRotationZ(0.8);
      const [, , rz4] = extractEulerAngles(m4);
      expect(rz4).toBeCloseTo(0.8);

      const m3 = new THREE.Matrix3().setFromMatrix4(m4);
      const [, , rz3] = extractEulerAngles(m3);
      expect(rz3).toBeCloseTo(0.8);
    });
  });
});
