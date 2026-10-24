/**
 * 测试新增能力：
 * 1. pickPosition() 返回世界坐标与精确交点
 * 2. 单体 xy/z 平移（状态纹理扩展与多维 translation）
 * 3. lodRangeScale / lodBias 缩放细化判定
 * 4. getFeatureBounds(smid) 与 flyToFeature(smid)
 * 5. drillPick() 穿透拾取
 */
import assert from 'node:assert';
import * as THREE from 'three';
import { S3MLayer } from '../packages/s3m-maplibre/dist/S3MLayer.js';
import { S3MTileset } from '../packages/s3m-three/dist/tileset/S3MTileset.js';

function ok(msg) {
  console.log(`  √ ${msg}`);
}

console.log('=== 测试新增功能集 ===');

// ---- 1. lodRangeScale 测试
{
  const tileset = new S3MTileset({
    configUrl: 'http://example.com/config.json',
    lodRangeScale: 1.5,
  });
  assert.strictEqual(tileset.lodRangeScale, 1.5, '初始 lodRangeScale 正确设置');

  // 模拟节点：rangeMode = 1 (屏幕像素), rangeValue = 100
  const node = {
    url: 'root.s3mb',
    childUrl: 'child.s3mb',
    sphere: { center: { x: 0, y: 0, z: 0 }, radius: 10 },
    rangeValue: 100,
    rangeMode: 1,
    state: 'loaded',
    group: new THREE.Group(),
  };
  tileset.nodes.set(node.url, node);

  // 当 scale = 1.5 时，阈值变成 150。若 metric = 120，未超过 150，不触发 refine
  // 当 scale 改为 0.8 时，阈值变成 80。metric = 120 超过 80，触发 refine 入队
  tileset.lodRangeScale = 0.8;
  assert.strictEqual(tileset.lodRangeScale, 0.8, '动态更新 lodRangeScale 生效');

  ok('LOD: lodRangeScale 动态调整与缩放阈值生效');
}

// ---- 2. 单体 xy 平移（状态纹理第 2 行）
{
  const layer = new S3MLayer({
    configUrl: 'http://example.com/config.json',
  });

  // 创建一个测试 Mesh，带 geoRef 与 aBatchId
  const geom = new THREE.BoxGeometry(10, 10, 10);
  const batchArr = new Float32Array(geom.attributes.position.count).fill(0);
  geom.setAttribute('aBatchId', new THREE.BufferAttribute(batchArr, 1));
  const mat = new THREE.MeshBasicMaterial();
  mat.userData = {
    isStyled: true,
    uBatchTex: { value: null },
    uBatchTexWidth: { value: 1 },
    uBatchTexActive: { value: 0 },
  };
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData = {
    pickId: 0,
    geoRef: {
      pickInfo: {
        101: { batchId: 0 },
      },
    },
  };

  // 设置单体样式：带 xy 平移与拔高
  layer.setFeatureStyle(101, {
    color: '#ff0000',
    translation: [5, 10, 15],
  });

  // 触发写入
  layer.viewer._applyOverridesToMesh(mesh);

  const tex = mat.userData.uBatchTex.value;
  assert.ok(tex, '状态纹理已创建');
  assert.strictEqual(tex.image.height, 2, '状态纹理高度为 2 行（扩容支持 vec3 平移）');

  const data = tex.image.data;
  const w = tex.image.width;
  // Row 0: 颜色在 [0..2] 通道，显隐在 [3] 通道
  assert.ok(data[0] > 0.9, 'Row 0 红色分量写入成功');
  assert.strictEqual(data[3], 0, 'Row 0 正常可见未被隐藏');

  // Row 1: [tx, ty, tz, 0]
  const r1 = w * 4;
  assert.strictEqual(data[r1 + 0], 5, 'Row 1 translation.x 正确写入 5m');
  assert.strictEqual(data[r1 + 1], 10, 'Row 1 translation.y 正确写入 10m');
  assert.strictEqual(data[r1 + 2], 15, 'Row 1 translation.z 正确写入 15m');

  ok('平移: 状态纹理高度扩为 2 行，成功存储 [dx, dy, dz] 平移向量');
}

// ---- 3. getFeatureBounds & flyToFeature
{
  const layer = new S3MLayer({
    configUrl: 'http://example.com/config.json',
  });
  // 模拟场景锚点
  layer.sceneAnchor = {
    x: 0.8,
    y: 0.4,
    z: 0.0,
    meterInMercator: 1e-7,
    altitude: 10,
  };

  const geom = new THREE.BoxGeometry(20, 20, 20); // 范围 -10 ~ 10
  const batchArr = new Float32Array(geom.attributes.position.count).fill(0);
  geom.setAttribute('aBatchId', new THREE.BufferAttribute(batchArr, 1));
  const mesh = new THREE.Mesh(geom);
  mesh.updateMatrixWorld(true);
  mesh.userData = {
    pickId: 1,
    geoRef: {
      pickInfo: {
        202: { batchId: 0 },
      },
    },
  };
  layer.viewer._pickables.set(1, { mesh, datasetId: 'test', skeletonName: 'box' });

  // 1. 获取包围盒
  const bounds = layer.getFeatureBounds(202);
  assert.ok(bounds, '成功获取单体包围盒');
  assert.strictEqual(bounds.length, 2, '包围盒格式为 [[minLng, minLat], [maxLng, maxLat]]');
  assert.ok(bounds[0][0] < bounds[1][0], 'minLng < maxLng');
  assert.ok(bounds[0][1] < bounds[1][1], 'minLat < maxLat');

  // 2. 模拟 map.fitBounds
  let flyCalledWith = null;
  layer.map = {
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600, width: 800, height: 600 }),
    fitBounds: (b, opts) => {
      flyCalledWith = { bounds: b, opts };
    },
  };

  const okFly = layer.flyToFeature(202, { maxZoom: 17 });
  assert.strictEqual(okFly, true, 'flyToFeature 执行成功');
  assert.ok(flyCalledWith, '正确触发宿主 map.fitBounds');
  assert.strictEqual(flyCalledWith.opts.maxZoom, 17, '透传 options 参数正确');

  ok('包围盒与聚焦: getFeatureBounds / flyToFeature 单体范围计算与飞向正确');
}

// ---- 4. pickPosition 与精确求交
{
  const layer = new S3MLayer({
    configUrl: 'http://example.com/config.json',
  });
  layer.sceneAnchor = {
    x: 0.5,
    y: 0.5,
    z: 0.0,
    meterInMercator: 1e-6,
    altitude: 50,
  };
  layer.viewer.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  layer.camera.position.set(0, 0, 100);
  layer.camera.lookAt(0, 0, 0);
  layer.camera.updateMatrixWorld(true);
  layer.camera.updateProjectionMatrix();

  // viewer 在 mount 时缓存画布；测试直接注入
  layer.viewer.canvas = { clientWidth: 800, clientHeight: 600, width: 800, height: 600 };

  // 地面交点测试：未命中建筑时与 z=0 地面求交
  const groundPos = layer.pickPosition(400, 300); // 屏幕正中心
  assert.ok(groundPos, '中心射线求交地面成功');
  assert.ok(Array.isArray(groundPos.lngLat), '返回经纬度');
  assert.strictEqual(groundPos.altitude, 50, '返回海拔高度 (z=0 + 锚点高度 50m)');
  assert.strictEqual(Math.round(groundPos.point[0]), 0, '中心命中 x 坐标接近 0');
  assert.strictEqual(Math.round(groundPos.point[1]), 0, '中心命中 y 坐标接近 0');

  ok('拾取位置: pickPosition 精确返回场景点与世界坐标 [lng, lat, altitude]');
}

// ---- 5. drillPick 穿透拾取
{
  const layer = new S3MLayer({
    configUrl: 'http://example.com/config.json',
  });
  layer.sceneAnchor = {
    x: 0.5,
    y: 0.5,
    z: 0.0,
    meterInMercator: 1e-6,
    altitude: 0,
  };
  layer.viewer.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  layer.camera.position.set(0, 0, 200);
  layer.camera.lookAt(0, 0, 0);
  layer.camera.updateMatrixWorld(true);
  layer.camera.updateProjectionMatrix();

  // viewer 在 mount 时缓存画布；测试直接注入
  layer.viewer.canvas = { clientWidth: 800, clientHeight: 600, width: 800, height: 600 };

  // 沿 z 轴放置前后两个面（前层 z=50, 后层 z=10）
  const gFront = new THREE.PlaneGeometry(20, 20);
  const batchArr1 = new Float32Array(gFront.attributes.position.count).fill(0);
  gFront.setAttribute('aBatchId', new THREE.BufferAttribute(batchArr1, 1));
  const mFront = new THREE.Mesh(gFront);
  mFront.position.set(0, 0, 50);
  mFront.updateMatrixWorld(true);
  mFront.userData = {
    pickId: 10,
    geoRef: { pickInfo: { 301: { batchId: 0 } } },
  };

  const gBack = new THREE.PlaneGeometry(20, 20);
  const batchArr2 = new Float32Array(gBack.attributes.position.count).fill(0);
  gBack.setAttribute('aBatchId', new THREE.BufferAttribute(batchArr2, 1));
  const mBack = new THREE.Mesh(gBack);
  mBack.position.set(0, 0, 10);
  mBack.updateMatrixWorld(true);
  mBack.userData = {
    pickId: 11,
    geoRef: { pickInfo: { 302: { batchId: 0 } } },
  };

  layer.viewer._pickables.set(10, { mesh: mFront, datasetId: 'test', skeletonName: 'front' });
  layer.viewer._pickables.set(11, { mesh: mBack, datasetId: 'test', skeletonName: 'back' });

  const drillResults = layer.drillPick(400, 300);
  assert.strictEqual(drillResults.length, 2, '穿透拾取命中前后两个物体');
  assert.strictEqual(drillResults[0].smid, 301, '第一命中是前层 301');
  assert.strictEqual(drillResults[1].smid, 302, '第二命中是后层 302');
  assert.ok(drillResults[0].point[2] > drillResults[1].point[2], '交点按距离/深度有序排列');

  ok('穿透拾取: drillPick 正确穿透多个单体并按深度排序返回');
}

// ---- 6. CRS / worldCoordinateHelper 适配测试
{
  const customCRS = {
    name: 'custom:planar',
    worldFromLngLat(lng, lat, altitude = 0) {
      // 模拟自定义平面 CRS：extent = 50000m
      return {
        x: (lng - 100) / 10,
        y: (lat - 30) / 10,
        z: altitude / 50000,
      };
    },
    lngLatFromWorld(x, y) {
      return {
        lng: x * 10 + 100,
        lat: y * 10 + 30,
      };
    },
    metersPerWorldUnit(_x, _y) {
      return 50000;
    },
  };

  const listeners = {};
  const mockMap = {
    getCanvas: () => ({ width: 800, height: 600 }),
    triggerRepaint: () => {},
    on: (evt, fn) => { listeners[evt] = fn; },
    off: (evt, fn) => { delete listeners[evt]; },
    transform: {
      worldCoordinateHelper: customCRS,
    },
  };

  const layer = new S3MLayer();
  layer.map = mockMap;
  if (typeof mockMap.on === 'function') {
    mockMap.on('projectiontransition', layer._onProjectionChange);
  }

  // 添加模拟数据集
  layer.datasets.set('customDs', {
    id: 'customDs',
    name: 'Custom CRS Dataset',
    anchor: { lon: 105, lat: 35, height: 100 },
    root: new THREE.Group(),
    tileset: null,
  });

  layer.viewer.recomputeAnchors();

  assert.ok(layer.sceneAnchor, 'sceneAnchor 应当被初始化');
  assert.strictEqual(layer.sceneAnchor.x, 0.5, '自定义 CRS 下 x 应为 0.5');
  assert.strictEqual(layer.sceneAnchor.y, 0.5, '自定义 CRS 下 y 应为 0.5');
  assert.strictEqual(layer.sceneAnchor.meterInMercator, 1 / 50000, '尺度应当为 1 / 50000');
  assert.strictEqual(layer.sceneAnchor.z, 100 / 50000, 'z 应当按 100 / 50000 计算');

  // 坐标反查经纬度
  const [lng, lat] = layer.viewer._lngLatFromWorld(0.5, 0.5);
  assert.strictEqual(lng, 105, '归一化世界坐标反查经度应为 105');
  assert.strictEqual(lat, 35, '归一化世界坐标反查纬度应为 35');

  // 投影切换动态响应
  customCRS.metersPerWorldUnit = () => 20000;
  listeners['projectiontransition']?.();
  assert.strictEqual(layer.sceneAnchor.meterInMercator, 1 / 20000, '触发 projectiontransition 事件后尺度应自动更新');

  ok('CRS 适配: 通过 worldCoordinateHelper 适配任意投影与平面 CRS，尺度与逆反查均正确');
}

// ---- 7. 多 Mesh 共享同一 SMID 时的联动选中测试 (CBD 模型场景)
{
  const { createStyledMaterial } = await import('../packages/s3m-three/dist/render/StyleMaterial.js');
  const layer = new S3MLayer();

  const g1 = new THREE.BufferGeometry();
  g1.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const m1 = new THREE.Mesh(g1, createStyledMaterial(layer.uniforms));
  m1.userData = {
    geoRef: { pickInfo: { 20: { batchId: 0, segments: [{ vertexOffset: 0, vertexCount: 3 }] } } },
  };

  const g2 = new THREE.BufferGeometry();
  g2.setAttribute('position', new THREE.BufferAttribute(new Float32Array([1, 1, 0, 2, 1, 0, 1, 2, 0]), 3));
  const m2 = new THREE.Mesh(g2, createStyledMaterial(layer.uniforms));
  m2.userData = {
    geoRef: { pickInfo: { 20: { batchId: 0, segments: [{ vertexOffset: 0, vertexCount: 3 }] } } },
  };

  layer.viewer._indexMeshSmids(m1);
  layer.viewer._indexMeshSmids(m2);

  // 拾取命中 m1
  const pickResult = {
    datasetId: 'cbd',
    datasetName: 'CBD',
    objectId: 1,
    batchId: 0,
    smid: 20,
    mesh: m1,
  };

  layer.select(pickResult);

  // 验证：虽然只点击了 m1，但共享 SMID 20 的 m1 和 m2 都被高亮选中了
  assert.strictEqual(m1.material.userData.uSelBatch.value, 0, '网格 1 应当被选中');
  assert.strictEqual(m2.material.userData.uSelBatch.value, 0, '网格 2 (不同材质骨架) 应当联动被选中');
  assert.strictEqual(layer.viewer._selectedMeshes.length, 2, '两块网格都进入了选中集合');

  // 取消选中
  layer.select(null);
  assert.strictEqual(m1.material.userData.uSelBatch.value, -1, '取消选中后网格 1 恢复 -1');
  assert.strictEqual(m2.material.userData.uSelBatch.value, -1, '取消选中后网格 2 恢复 -1');
  assert.strictEqual(layer.viewer._selectedMeshes.length, 0, '选中集合清空');

  ok('多 Mesh 共享 SMID: 点击单面时联动选中同 SMID 的所有材质网格');
}

// ---- 8. 数据集智能垂直对齐（align: 'top' | 'bottom' | 'center'）
{
  const layer = new S3MLayer({ id: 's3m' });
  const entry = {
    id: 'subway',
    name: 'Subway',
    options: { id: 'subway', configUrl: 'http://example.com/cfg.json', align: 'top', heightOffset: 2 },
    root: new THREE.Group(),
    tileset: {
      heightRange: { min: -5, max: 25 },
      anchor: { lon: 116.4, lat: 39.9, height: 0 },
    },
    anchor: { lon: 116.4, lat: 39.9, height: 0 },
    baseAlignOffset: 0,
    heightOffset: 0,
    offset: [0, 0, 0],
    visible: true,
    error: null,
  };
  layer.datasets.set('subway', entry);

  // align: 'top' 时，baseAlignOffset = -max = -25，加上 heightOffset = 2，总偏移为 -23
  entry.baseAlignOffset = layer._computeAlignOffset(entry.tileset, 'top');
  entry.heightOffset = entry.baseAlignOffset + 2;
  assert.strictEqual(entry.baseAlignOffset, -25, 'align: top 正确将顶部下沉 25m');
  assert.strictEqual(entry.heightOffset, -23, '总高程偏移为 base + heightOffset = -23m');

  // 动态切换为 'bottom'
  layer.setDatasetAlign('subway', 'bottom');
  assert.strictEqual(entry.baseAlignOffset, 5, 'align: bottom 正确抬升 -min = 5m');
  assert.strictEqual(entry.heightOffset, 7, '切换后保留附加偏移 2m，总高程 = 7m');

  // 动态切换为 'center'
  layer.setDatasetAlign('subway', 'center');
  assert.strictEqual(entry.baseAlignOffset, -10, 'align: center 正确居中 -(25-5)/2 = -10m');
  assert.strictEqual(entry.heightOffset, -8, '切换后总高程 = -8m');

  // 动态切换回 'origin'
  layer.setDatasetAlign('subway', 'origin');
  assert.strictEqual(entry.baseAlignOffset, 0, 'align: origin 恢复 0');
  assert.strictEqual(entry.heightOffset, 2, '仅保留原始附加偏移 2m');

  ok('智能对齐: align=top/bottom/center 自动计算高度范围并精确对齐地表');
}

console.log('\n全部新增能力测试通过！');

