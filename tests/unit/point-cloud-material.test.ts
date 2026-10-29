import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import { STYLE, type S3MStyle } from '../../packages/s3m-three/src/render/StyleMaterial.js';
import {
  applyPointCloudStyle,
  isOwnedPointCloudMaterial,
  pointCloudKindOf,
} from '../../packages/s3m-three/src/render/PointCloudMaterial.js';
import type { StyleUniforms } from '../../packages/s3m-three/src/core/types.js';

function createMockUniforms(): StyleUniforms {
  return {
    uColorA: { value: new THREE.Color(0xff0000) },
    uColorB: { value: new THREE.Color(0x00ff00) },
    uHeightMin: { value: 0 },
    uHeightMax: { value: 100 },
    uSelColor: { value: new THREE.Color(0xffff00) },
    uSelMix: { value: 0 },
    uDim: { value: 0 },
    uTime: { value: 0 },
    uScanCenter: { value: new THREE.Vector3() },
    uScanRadius: { value: 0 },
    uEdgeColor: { value: new THREE.Color() },
  } as unknown as StyleUniforms;
}

describe('PointCloudMaterial', () => {
  describe('pointCloudKindOf', () => {
    it('SOLID 和 HEIGHT 映射到各自形态，其余一律回退 vertex', () => {
      expect(pointCloudKindOf(STYLE.SOLID)).toBe('solid');
      expect(pointCloudKindOf(STYLE.HEIGHT)).toBe('height');
      expect(pointCloudKindOf(STYLE.WIRE)).toBe('vertex');
      expect(pointCloudKindOf(STYLE.NONE)).toBe('vertex');
      expect(pointCloudKindOf(STYLE.PBR)).toBe('vertex');
      expect(pointCloudKindOf(STYLE.SCAN)).toBe('vertex');
    });
  });

  describe('isOwnedPointCloudMaterial', () => {
    it('未定义或普通材质返回 false', () => {
      expect(isOwnedPointCloudMaterial(undefined)).toBe(false);
      const mat = new THREE.PointsMaterial();
      expect(isOwnedPointCloudMaterial(mat)).toBe(false);
    });

    it('持有 pcOwned 标记的材质返回 true（支持单材质与数组）', () => {
      const mat = new THREE.PointsMaterial();
      mat.userData = { pcOwned: true };
      expect(isOwnedPointCloudMaterial(mat)).toBe(true);
      expect(isOwnedPointCloudMaterial([mat])).toBe(true);
    });
  });

  describe('applyPointCloudStyle', () => {
    it('默认 vertex 模式创建带 vertexColors 的 PointsMaterial', () => {
      const points = new THREE.Points();
      const style: S3MStyle = { mode: STYLE.NONE };
      const uniforms = createMockUniforms();

      applyPointCloudStyle(points, style, uniforms);

      expect(points.material).toBeInstanceOf(THREE.PointsMaterial);
      const mat = points.material as THREE.PointsMaterial;
      expect(mat.vertexColors).toBe(true);
      expect(mat.userData.pcOwned).toBe(true);
      expect((points.userData as any).pcKind).toBe('vertex');
    });

    it('solid 模式：创建带颜色的 PointsMaterial，样式更新时复用材质只改颜色', () => {
      const points = new THREE.Points();
      const style: S3MStyle = { mode: STYLE.SOLID, colorA: '#ff0000' };
      const uniforms = createMockUniforms();

      applyPointCloudStyle(points, style, uniforms);
      const firstMat = points.material as THREE.PointsMaterial;
      expect(firstMat.color.getHexString()).toBe('ff0000');

      // 再次应用相同 solid 模式但改颜色：不重建材质
      applyPointCloudStyle(points, { mode: STYLE.SOLID, colorA: '#0000ff' }, uniforms);
      expect(points.material).toBe(firstMat);
      expect(firstMat.color.getHexString()).toBe('0000ff');
    });

    it('height 模式：创建 ShaderMaterial 并直接引用共享 uniforms', () => {
      const points = new THREE.Points();
      const style: S3MStyle = { mode: STYLE.HEIGHT, opacity: 0.8 };
      const uniforms = createMockUniforms();

      applyPointCloudStyle(points, style, uniforms);

      expect(points.material).toBeInstanceOf(THREE.ShaderMaterial);
      const mat = points.material as THREE.ShaderMaterial;
      expect(mat.uniforms.uColorA).toBe(uniforms.uColorA);
      expect(mat.uniforms.uColorB).toBe(uniforms.uColorB);
      expect(mat.uniforms.uHeightMin).toBe(uniforms.uHeightMin);
      expect(mat.uniforms.uHeightMax).toBe(uniforms.uHeightMax);
      expect(mat.uniforms.uOpacity.value).toBe(0.8);
      expect(mat.transparent).toBe(true);
    });

    it('selected 优先：无论当前 mode 统一采用 selected 材质', () => {
      const points = new THREE.Points();
      const style: S3MStyle = { mode: STYLE.HEIGHT };
      const uniforms = createMockUniforms();

      applyPointCloudStyle(points, style, uniforms, true);

      expect(points.material).toBeInstanceOf(THREE.ShaderMaterial);
      const mat = points.material as THREE.ShaderMaterial;
      expect(mat.uniforms.uSelColor).toBe(uniforms.uSelColor);
      expect((points.userData as any).pcKind).toBe('selected');
    });

    it('切换形态时释放旧的 pcOwned 材质，但保护非 pcOwned 外部单例材质', () => {
      const points = new THREE.Points();
      const externalMat = new THREE.PointsMaterial();
      let externalDisposed = false;
      externalMat.dispose = () => { externalDisposed = true; };
      points.material = externalMat;

      const uniforms = createMockUniforms();
      // 切换到 solid：外部材质不应该被 dispose
      applyPointCloudStyle(points, { mode: STYLE.SOLID, colorA: '#ff0000' }, uniforms);
      expect(externalDisposed).toBe(false);

      const ownedMat = points.material as THREE.PointsMaterial;
      let ownedDisposed = false;
      ownedMat.dispose = () => { ownedDisposed = true; };

      // 切换到 height：自己持有的 ownedMat 必须被销毁
      applyPointCloudStyle(points, { mode: STYLE.HEIGHT }, uniforms);
      expect(ownedDisposed).toBe(true);
    });

    it('透明度边界 clamp 与 needsUpdate 状态切换', () => {
      const points = new THREE.Points();
      const uniforms = createMockUniforms();

      // 超小透明度 clamp 到 0.05
      applyPointCloudStyle(points, { mode: STYLE.NONE, opacity: 0.01 }, uniforms);
      let mat = points.material as THREE.PointsMaterial;
      expect(mat.opacity).toBe(0.05);
      expect(mat.transparent).toBe(true);

      // 切换到完全不透明 1.0 时触发 needsUpdate
      const v0 = mat.version;
      applyPointCloudStyle(points, { mode: STYLE.NONE, opacity: 1.0 }, uniforms);
      mat = points.material as THREE.PointsMaterial;
      expect(mat.opacity).toBe(1.0);
      expect(mat.transparent).toBe(false);
      expect(mat.version).toBeGreaterThan(v0);
      expect((points.userData as any).pcTransparent).toBe(false);
    });
  });
});
