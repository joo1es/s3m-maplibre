/**
 * 单元测试：光照可调 (Adjustable Lighting)
 *
 * 验证：
 * 1. S3MViewer 默认光照参数（环境光、主光、补光、头灯模式）
 * 2. setLight() 动态调整各光源强度（intensity）与颜色（color）
 * 3. 光照朝向模式切换：
 *    - 'headlamp'（默认头灯）：光照方位角随相机地图 bearing 旋转；
 *    - 'fixed'（固定世界坐标）：光照方位角固定（如模拟太阳入射角），不随视角旋转而旋转；
 * 4. getLight() 返回当前完整光照配置快照；
 * 5. S3MLayer 透传 light 配置与 setLight / getLight API。
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { S3MViewer, type LightOptions } from '../../packages/s3m-three/src/render/S3MViewer';
import { S3MLayer } from '../../packages/s3m-maplibre/src/S3MLayer';

function createMockViewer(options: { light?: LightOptions } = {}) {
  const viewer = new S3MViewer(options);
  // viewer 初始化会建立 scene 与 lights
  return viewer as any;
}

describe('光照可调 (Adjustable Lighting)', () => {
  test('1. 默认光照参数初始化正确', () => {
    const viewer = createMockViewer();
    const light = viewer.getLight();

    expect(light.ambientIntensity).toBeCloseTo(0.4, 2);
    expect(light.keyLightIntensity).toBeCloseTo(1.0, 2);
    expect(light.fillLightIntensity).toBeCloseTo(0.35, 2);
    expect(light.mode).toBe('headlamp');
    expect(light.azimuth).toBe(150);
    expect(light.altitude).toBe(50);
  });

  test('2. 构造函数可传入自定义光照参数', () => {
    const viewer = createMockViewer({
      light: {
        ambientIntensity: 0.8,
        ambientColor: 0xffeedd,
        keyLightIntensity: 1.5,
        keyLightColor: '#ff0000',
        fillLightIntensity: 0.1,
        mode: 'fixed',
        azimuth: 45,
        altitude: 30,
      },
    });

    const light = viewer.getLight();
    expect(light.ambientIntensity).toBeCloseTo(0.8, 2);
    expect(light.keyLightIntensity).toBeCloseTo(1.5, 2);
    expect(light.fillLightIntensity).toBeCloseTo(0.1, 2);
    expect(light.mode).toBe('fixed');
    expect(light.azimuth).toBe(45);
    expect(light.altitude).toBe(30);

    // 检查内部 three.js 光源对象属性
    expect(viewer._ambientLight.intensity).toBeCloseTo(0.8, 2);
    expect(viewer._keyLight.intensity).toBeCloseTo(1.5, 2);
    expect(viewer._fillLight.intensity).toBeCloseTo(0.1, 2);
    expect(viewer._keyLight.color.getHexString()).toBe('ff0000');
  });

  test('3. setLight() 动态调整强度与颜色，并触发重绘', () => {
    const viewer = createMockViewer();
    let repainted = false;
    viewer.triggerRepaint = () => { repainted = true; };

    viewer.setLight({
      keyLightIntensity: 2.0,
      ambientIntensity: 0.6,
      fillLightColor: 0x00ff00,
    });

    const light = viewer.getLight();
    expect(light.keyLightIntensity).toBeCloseTo(2.0, 2);
    expect(light.ambientIntensity).toBeCloseTo(0.6, 2);
    expect(viewer._keyLight.intensity).toBeCloseTo(2.0, 2);
    expect(viewer._ambientLight.intensity).toBeCloseTo(0.6, 2);
    expect(viewer._fillLight.color.getHex()).toBe(0x00ff00);
    expect(repainted).toBe(true);
  });

  test('4. headlamp 模式：光源位置随相机 bearing 旋转', () => {
    let currentBearing = 0;
    const viewer = createMockViewer({ light: { mode: 'headlamp', azimuth: 150, altitude: 50 } });
    viewer._getBearing = () => currentBearing;

    // bearing = 0
    viewer._updateLights();
    const pos0 = viewer._keyLight.position.clone();

    // bearing 旋转 90 度
    currentBearing = 90;
    viewer._updateLights();
    const pos90 = viewer._keyLight.position.clone();

    // 在 headlamp 模式下，光源方位角加上了 bearing，因此 X/Y 位置必须改变
    expect(pos0.x).not.toBeCloseTo(pos90.x, 1);
    expect(pos0.y).not.toBeCloseTo(pos90.y, 1);
    // 高度 Z 由 altitude 决定，应该保持不变
    expect(pos0.z).toBeCloseTo(pos90.z, 1);
  });

  test('5. fixed 模式：光源位置不受相机 bearing 影响', () => {
    let currentBearing = 0;
    const viewer = createMockViewer({ light: { mode: 'fixed', azimuth: 120, altitude: 45 } });
    viewer._getBearing = () => currentBearing;

    viewer._updateLights();
    const pos0 = viewer._keyLight.position.clone();

    // 视角旋转 180 度
    currentBearing = 180;
    viewer._updateLights();
    const pos180 = viewer._keyLight.position.clone();

    // fixed 模式下世界方位角固定，位置完全不变
    expect(pos0.x).toBeCloseTo(pos180.x, 2);
    expect(pos0.y).toBeCloseTo(pos180.y, 2);
    expect(pos0.z).toBeCloseTo(pos180.z, 2);
  });

  test('6. S3MLayer 透传 light 配置并提供 setLight/getLight', () => {
    const layer = new S3MLayer({
      id: 'test-s3m',
      light: {
        ambientIntensity: 0.5,
        mode: 'fixed',
      },
    });

    const light = layer.getLight();
    expect(light.ambientIntensity).toBeCloseTo(0.5, 2);
    expect(light.mode).toBe('fixed');

    layer.setLight({ keyLightIntensity: 1.8 });
    expect(layer.getLight().keyLightIntensity).toBeCloseTo(1.8, 2);

    // mainIntensity 兼容别名
    layer.setLight({ mainIntensity: 2.2 });
    expect(layer.getLight().keyLightIntensity).toBeCloseTo(2.2, 2);
  });

  test('7. 支持 toneMapping 配置，且默认 THREE.NoToneMapping', () => {
    const viewer = new S3MViewer();
    expect(viewer.getToneMapping().toneMapping).toBe(THREE.NoToneMapping);

    viewer.setToneMapping(THREE.ACESFilmicToneMapping, 1.2);
    expect(viewer.getToneMapping().toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(viewer.getToneMapping().toneMappingExposure).toBeCloseTo(1.2, 2);

    const customViewer = new S3MViewer({
      toneMapping: THREE.ReinhardToneMapping,
      toneMappingExposure: 1.5,
    });
    expect(customViewer.getToneMapping().toneMapping).toBe(THREE.ReinhardToneMapping);
    expect(customViewer.getToneMapping().toneMappingExposure).toBeCloseTo(1.5, 2);
  });

  test('8. StyleMaterial 支持 ambientGain（基础漫反射底色直通增益）', () => {
    const viewer = new S3MViewer({
      style: {
        ambientGain: 0.25,
      },
    });

    expect(viewer.uniforms.uAmbientGain?.value).toBeCloseTo(0.25, 2);
    expect(viewer.style.ambientGain).toBeCloseTo(0.25, 2);

    viewer.setStyle({ ambientGain: 0.4 });
    expect(viewer.uniforms.uAmbientGain?.value).toBeCloseTo(0.4, 2);
  });
});
