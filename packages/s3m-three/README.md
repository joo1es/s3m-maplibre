# s3m-three

SuperMap S3M 三维模型格式的 **three.js 渲染内核**（宿主无关）。

浏览器内直接解析 `.s3mb` / `.s3mblock` / `.s3m` 瓦片，不需要预先转成 3D Tiles，也不需要 SuperMap 的 WebGL 客户端：

- `core/` 纯解析（无 three 依赖，Node 可跑）
- `tileset/` 瓦片树 + LOD + 加载调度
- `render/S3MViewer` 宿主无关场景查看器：多数据集叠加、白膜 / 按高度 / 按单体 / 动态扫描着色、单体级 GPU 拾取、选中描边、单体样式与业务字段专题着色

## 安装

```bash
npm install s3m-three three
```

`three` 是 peer 依赖（`>=0.155.0`）。

## 30 秒上手

```js
import * as THREE from 'three';
import { S3MViewer } from 's3m-three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);

const viewer = new S3MViewer({ configUrl: 'https://host/.../config' });
viewer.mount(renderer.domElement, renderer.getContext());

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 60000);
const mvp = new THREE.Matrix4();

function tick() {
  // 你自己的相机与投影矩阵；viewer 只负责把 S3M 瓦片画进去
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  viewer.renderFrame({
    mvp: mvp.elements,
    cameraEnu: [camera.position.x, -camera.position.z, camera.position.y], // three(y↑) → ENU(z↑)
    fovRad: THREE.MathUtils.degToRad(camera.fov),
    canvasHeight: renderer.domElement.height,
  });
  requestAnimationFrame(tick);
}
tick();
```

地理坐标通过可注入的 `GeoAdapter` 接口适配（默认标准 Web 墨卡托兜底）；
接 MapLibre / Mapbox 请改用 [`s3m-maplibre`](https://www.npmjs.com/package/s3m-maplibre) 的 `S3MLayer`。

完整 API 见 **[docs/API.md](./docs/API.md)**（样式系统、字段着色、底层解析、性能调优）；
架构说明与在线演示见 <https://github.com/joo1es/s3m-maplibre>。

## 许可

Apache-2.0
