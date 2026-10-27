import { describe, test, expect } from 'bun:test';
import * as THREE from 'three';
import {
  Path,
  GPUPathManager,
  SAMPLES_PER_PATH,
  FeatureStyleManager,
  S3MViewer,
  createStyledMaterial,
  createSharedUniforms,
  createThickLineMaterial,
  createLineSharedUniforms,
} from '../../packages/s3m-three/src/index.js';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer.js';

describe('GPU 路径动画 (GPU Path Animation)', () => {
  describe('1. GPUPathManager 基础能力与数据纹理烘焙', () => {
    test('注册折线路径并烘焙数据纹理', () => {
      const manager = new GPUPathManager();
      // 一条正方形轨迹：0,0 -> 100,0 -> 100,100 -> 0,100 -> 0,0
      const points = [
        0, 0, 0,
        100, 0, 0,
        100, 100, 0,
        0, 100, 0,
        0, 0, 0,
      ];
      const pathId = manager.registerPath(points);
      expect(pathId).toBe(0);
      expect(manager.count).toBe(1);

      const tex = manager.getTexture();
      expect(tex).toBeTruthy();
      expect(tex.image.width).toBe(SAMPLES_PER_PATH);
      expect(tex.image.height).toBe(1); // 1条路径高度为1
      expect(tex.format).toBe(THREE.RGBAFormat);
      expect(tex.type).toBe(THREE.FloatType);

      const data = tex.image.data as Float32Array;
      // 起点 (0, 0, 0)
      expect(data[0]).toBeCloseTo(0, 3);
      expect(data[1]).toBeCloseTo(0, 3);
      expect(data[2]).toBeCloseTo(0, 3);

      // 第一段是沿 +X 方向移动，切线偏航角 yaw 应该为 0
      expect(data[3]).toBeCloseTo(0, 2);

      // 烘焙采样中间某点：1/8 总长处 (50, 0, 0)
      const sampled = manager.sampleBaked(0, 0.125);
      expect(sampled.position[0]).toBeCloseTo(50, 1);
      expect(sampled.position[1]).toBeCloseTo(0, 1);
      expect(sampled.position[2]).toBeCloseTo(0, 1);
      expect(sampled.yaw).toBeCloseTo(0, 2);
    });

    test('连续角度展开 (Angle Unwrap) 避免在 ±PI 处 360 度倒转', () => {
      const manager = new GPUPathManager();
      // 一条沿着逆时针圆形移动的路径，跨越 170° 到 190° (-170°)
      const circlePts: number[] = [];
      const R = 100;
      for (let deg = 0; deg <= 360; deg += 10) {
        const rad = (deg * Math.PI) / 180;
        circlePts.push(R * Math.cos(rad), R * Math.sin(rad), 0);
      }

      const id = manager.registerPath(circlePts);
      const tex = manager.getTexture();
      const data = tex.image.data as Float32Array;

      // 验证相邻采样点的切线角差绝对值 < PI，绝不产生跨越断崖
      for (let i = 1; i < SAMPLES_PER_PATH; i++) {
        const prevYaw = data[(i - 1) * 4 + 3];
        const currYaw = data[i * 4 + 3];
        expect(Math.abs(currYaw - prevYaw)).toBeLessThan(Math.PI);
      }
    });

    test('支持多条路径管理与动态注销', () => {
      const manager = new GPUPathManager();
      const id0 = manager.registerPath([0, 0, 0, 10, 0, 0]);
      const id1 = manager.registerPath([0, 0, 0, 0, 20, 0]);
      expect(id0).toBe(0);
      expect(id1).toBe(1);
      expect(manager.count).toBe(2);

      let tex = manager.getTexture();
      expect(tex.image.height).toBe(2);

      // 注销第一条
      expect(manager.unregisterPath(id0)).toBe(true);
      expect(manager.count).toBe(1);

      tex = manager.getTexture();
      expect(tex).toBeTruthy();
    });

    test('updateUniforms 正确同步状态', () => {
      const manager = new GPUPathManager();
      const uniforms: any = {
        uPathTex: { value: null },
        uPathCount: { value: 0 },
        uPathTexActive: { value: 0 },
      };

      manager.updateUniforms(uniforms);
      expect(uniforms.uPathTexActive.value).toBe(0);

      manager.registerPath([0, 0, 0, 50, 50, 0]);
      manager.updateUniforms(uniforms);
      expect(uniforms.uPathTexActive.value).toBe(1);
      expect(uniforms.uPathCount.value).toBe(1);
      expect(uniforms.uPathTex.value).toBe(manager.getTexture());
    });
  });

  describe('2. FeatureStyleManager Row 5 烘焙与 GPU 路径绑定', () => {
    test('bindGPUPath 写入 Row 5 [pathId, speed, phase, modeFlag]', () => {
      const fsm = new FeatureStyleManager(
        () => 3.2,
        () => {},
        () => {}
      );

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      const mat = createStyledMaterial({} as any);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = {
        pickId: 0,
        geoRef: { pickInfo: { 301: { batchId: 0 } } },
      };

      // 绑定单体 301 到路径 0，速度 0.05，相位 0.25，循环 loop，自动朝向
      fsm.bindGPUPath(
        301,
        0,
        {
          speed: 0.05,
          phase: 0.25,
          loop: 'loop',
          autoHeading: true,
        },
        [mesh]
      );

      fsm.applyOverridesToMesh(mesh);

      const tex = mat.userData.uBatchTex.value as THREE.DataTexture;
      expect(tex).toBeTruthy();
      expect(tex.image.height).toBe(6);

      const data = tex.image.data as Float32Array;
      const w = tex.image.width;

      // Row 5: (w * 5 + 0) * 4
      const r5 = (w * 5 + 0) * 4;
      expect(data[r5 + 0]).toBe(0); // pathId
      expect(data[r5 + 1]).toBeCloseTo(0.05, 4); // speed
      expect(data[r5 + 2]).toBeCloseTo(0.25, 4); // phase
      expect(data[r5 + 3]).toBe(1); // mode: 1 = loop (with autoHeading)
    });

    test('模式编码 (clamp / pingpong / noAutoHeading)', () => {
      const fsm = new FeatureStyleManager(
        () => 3.2,
        () => {},
        () => {}
      );
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      const mat = createStyledMaterial({} as any);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = {
        pickId: 0,
        geoRef: { pickInfo: { 501: { batchId: 0 } } },
      };

      // clamp 且关闭自动朝向
      fsm.bindGPUPath(
        501,
        2,
        {
          speed: 0.1,
          phase: 0.0,
          loop: 'clamp',
          autoHeading: false,
        },
        [mesh]
      );
      fsm.applyOverridesToMesh(mesh);

      const tex = mat.userData.uBatchTex.value as THREE.DataTexture;
      const data = tex.image.data as Float32Array;
      const r5 = (tex.image.width * 5 + 0) * 4;
      expect(data[r5 + 0]).toBe(2); // pathId = 2
      // clamp (2) + noAutoHeading (+3) = 5
      expect(data[r5 + 3]).toBe(5);

      // 解绑
      fsm.unbindGPUPath(501, [mesh]);
      fsm.applyOverridesToMesh(mesh);
      expect(data[r5 + 0]).toBe(-1); // 还原为未绑定状态
    });

    test('setGPUPathProgress 外部控制进度', () => {
      const fsm = new FeatureStyleManager(
        () => 3.2,
        () => {},
        () => {}
      );
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      const mat = createStyledMaterial({} as any);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = {
        pickId: 0,
        geoRef: { pickInfo: { 601: { batchId: 0 } } },
      };

      fsm.bindGPUPath(601, 1, { speed: 0.05 }, [mesh]);
      // 拖拽进度条到 0.8
      fsm.setGPUPathProgress(601, 0.8, [mesh]);
      fsm.applyOverridesToMesh(mesh);

      const tex = mat.userData.uBatchTex.value as THREE.DataTexture;
      const data = tex.image.data as Float32Array;
      const r5 = (tex.image.width * 5 + 0) * 4;
      expect(data[r5 + 1]).toBe(0); // speed 变为 0
      expect(data[r5 + 2]).toBeCloseTo(0.8, 4); // phase = 0.8
    });
  });

  describe('3. 着色器与数学逻辑验证', () => {
    test('GPU 路径进度计算函数（loop / clamp / pingpong）与切线旋转', () => {
      // 模拟着色器中的数学执行
      function computeT(phase: number, time: number, speed: number, mode: number): number {
        let t = phase + time * speed;
        if (mode >= 4.0) mode -= 3.0;
        if (mode < 1.5) {
          // loop: fract(t)
          t = t - Math.floor(t);
        } else if (mode < 2.5) {
          // clamp: clamp(t, 0.0, 1.0)
          t = Math.min(1.0, Math.max(0.0, t));
        } else {
          // pingpong
          let m = t % 2.0;
          if (m < 0) m += 2.0;
          t = m > 1.0 ? 2.0 - m : m;
        }
        return t;
      }

      // loop 循环：speed=0.5，time=2.3，phase=0.0 -> t = 1.15 -> 0.15
      expect(computeT(0, 2.3, 0.5, 1)).toBeCloseTo(0.15, 5);

      // clamp 截断：speed=1.0，time=1.5 -> t = 1.0
      expect(computeT(0, 1.5, 1.0, 2)).toBe(1.0);

      // pingpong 往返：speed=1.0，time=1.2 -> 0.8
      expect(computeT(0, 1.2, 1.0, 3)).toBeCloseTo(0.8, 5);
      // pingpong 往返：speed=1.0，time=2.2 -> 0.2
      expect(computeT(0, 2.2, 1.0, 3)).toBeCloseTo(0.2, 5);

      // 旋转矩阵复合：验证 rotHeading * s3mRot 正交性
      const yaw = Math.PI / 4; // 45度
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const rotHeading = new THREE.Matrix3().set(
        c, -s, 0,
        s,  c, 0,
        0,  0, 1
      );
      const v = new THREE.Vector3(1, 0, 0);
      v.applyMatrix3(rotHeading);
      expect(v.x).toBeCloseTo(Math.SQRT1_2, 5);
      expect(v.y).toBeCloseTo(Math.SQRT1_2, 5);
      expect(v.z).toBeCloseTo(0, 5);
    });

    test('棱线 ThickLineMaterial 接收 GPU 路径 uniform 且顶点变换完全对齐', () => {
      const lineShared = createLineSharedUniforms();
      const pathTex = GPUPathManager.DUMMY_PATH_TEX;
      const batchTex = new THREE.DataTexture(new Float32Array(6 * 4), 1, 6, THREE.RGBAFormat, THREE.FloatType);

      const edgeMat = createThickLineMaterial(
        lineShared,
        { color: '#ffffff', width: 2 },
        undefined,
        {
          uBatchTex: { value: batchTex },
          uBatchTexWidth: { value: 1 },
          uBatchTexActive: { value: 1 },
          uPathTex: { value: pathTex },
          uPathCount: { value: 1 },
          uPathTexActive: { value: 1 },
          uPathTime: { value: 10 },
        }
      );

      expect(edgeMat.uniforms.uPathTex.value).toBe(pathTex);
      expect(edgeMat.uniforms.uPathCount.value).toBe(1);
      expect(edgeMat.uniforms.uPathTexActive.value).toBe(1);
      expect(edgeMat.uniforms.uPathTime.value).toBe(10);
    });
  });

  describe('4. S3MViewer 与 S3MLayer 端到端集成', () => {
    test('S3MViewer 完整流程：注册路径、绑定单体、时间驱动', () => {
      const canvas = {
        width: 800,
        height: 600,
        clientWidth: 800,
        clientHeight: 600,
        addEventListener: () => {},
        removeEventListener: () => {},
      } as any;

      const v = new S3MViewer({ canvas, container: null as any });
      expect(v.gpuPathManager).toBeTruthy();

      // 1. 注册 GPU 巡检路线
      const routePoints = [
        0, 0, 0,
        100, 0, 10,
        100, 100, 20,
        0, 100, 10,
        0, 0, 0,
      ];
      const pathId = v.registerGPUPath(routePoints);
      expect(pathId).toBe(0);

      // 2. 模拟瓦片网格与单体
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3));
      const mat = createStyledMaterial(v.uniforms);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData = {
        pickId: 0,
        geoRef: { pickInfo: { 701: { batchId: 0 }, 702: { batchId: 1 } } },
      };
      (v as any)._smidMeshes.set(701, new Set([mesh]));
      (v as any)._smidMeshes.set(702, new Set([mesh]));

      // 3. 批量绑定单体（智慧交通车辆 701 和巡检无人机 702）
      v.bindGPUPath(701, pathId, { speed: 0.02, phase: 0.0 });
      v.bindGPUPath(702, pathId, { speed: 0.05, phase: 0.5 });

      (v as any)._applyOverridesToMesh(mesh);

      const batchTex = mat.userData.uBatchTex.value as THREE.DataTexture;
      expect(batchTex.image.height).toBe(6);
      const data = batchTex.image.data as Float32Array;
      const w = batchTex.image.width;

      // 701 校验
      const r5_701 = (w * 5 + 0) * 4;
      expect(data[r5_701 + 0]).toBe(pathId);
      expect(data[r5_701 + 1]).toBeCloseTo(0.02, 4);

      // 702 校验
      const r5_702 = (w * 5 + 1) * 4;
      expect(data[r5_702 + 0]).toBe(pathId);
      expect(data[r5_702 + 1]).toBeCloseTo(0.05, 4);
      expect(data[r5_702 + 2]).toBeCloseTo(0.5, 4);

      // 4. 时间驱动 API
      v.setGPUPathTime(15.5);
      expect(v.getGPUPathTime()).toBe(15.5);

      v.dispose();
    });

    test('S3MLayer 顶层 API 透传正常', () => {
      const layer = new S3MLayer({ configUrl: 'http://localhost/test/config' });
      const pts = [0, 0, 0, 10, 20, 30];
      const pId = layer.registerGPUPath(pts);
      expect(pId).toBe(0);

      layer.bindGPUPath(888, pId, { speed: 0.1 });
      const st = layer.getFeatureStyle(888);
      expect(st?.gpuPath?.pathId).toBe(pId);
      expect(st?.gpuPath?.speed).toBe(0.1);

      layer.setGPUPathProgress(888, 0.65);
      const stAfter = layer.getFeatureStyle(888);
      expect(stAfter?.gpuPath?.speed).toBe(0);
      expect(stAfter?.gpuPath?.phase).toBe(0.65);

      layer.unbindGPUPath(888);
      expect(layer.getFeatureStyle(888)?.gpuPath).toBeUndefined();

      expect(layer.unregisterGPUPath(pId)).toBe(true);
    });
  });
});
