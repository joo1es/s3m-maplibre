# s3m-maplibre

SuperMap S3M 三维模型格式的 **MapLibre / Mapbox 原生渲染图层**。

在 MapLibre GL JS 里直接解析 `.s3mb` 瓦片并渲染，不需要预先转成 3D Tiles，也不需要 SuperMap 的 WebGL 客户端。渲染能力来自 [`s3m-three`](https://www.npmjs.com/package/s3m-three)（安装本包会自动带上）。

## 安装

```bash
npm install s3m-maplibre three
```

`three` 是 peer 依赖（`>=0.155.0`）。`maplibre-gl` 不是依赖——图层只是一个符合 `CustomLayerInterface` 的普通对象，MapLibre GL JS v4/v5 与 Mapbox GL JS v2/v3 都能挂。

## 30 秒上手

```js
import { S3MLayer } from 's3m-maplibre';

const layer = new S3MLayer({
  configUrl: 'https://host/.../3D-local3DCache-xxx/rest/realspace/datas/Xxx/config',
  style: { mode: 'texture' },
  onPick: (r) => console.log(r?.smid, r?.lngLat),
});
map.addLayer(layer);
```

多数据集叠加、白膜 / 按高度 / 按单体 / 动态扫描着色、单体级 GPU 拾取与属性查询、选中描边、正交投影等能力的完整文档见 <https://github.com/joo1es/s3m-maplibre>。

完整 API 见 **[docs/API.md](./docs/API.md)**；样式系统、字段着色、底层解析等内核能力见 [`s3m-three` 的 API 文档](../s3m-three/docs/API.md)。

不接地图、只要 three 场景？直接用 `s3m-three` 的 `S3MViewer`。

## 许可

Apache-2.0
