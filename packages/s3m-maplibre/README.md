# s3m-maplibre

SuperMap S3M 三维模型格式的 **MapLibre / Mapbox 原生渲染图层**。

在 MapLibre GL JS 里直接解析 `.s3mb` / `.s3mblock` / `.s3m` 瓦片并渲染，不需要预先转成 3D Tiles，也不需要 SuperMap 的 WebGL 客户端。渲染能力来自 [`s3m-three`](https://www.npmjs.com/package/s3m-three)（安装本包会自动带上）。

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

## 自定义投影适配（GeoAdapter）

默认情况下本层从 MapLibre 的 `transform.worldCoordinateHelper` 自动推断当前投影，
把 S3M 锚点（经纬度）换算成宿主世界坐标。对**标准经纬度 S3M + 任意底图 CRS**
（如 CGCS2000 / 4547 分带投影）这已自动工作，无需任何配置。

当你要**完全接管**「经纬度 → 世界坐标」换算（例如模型自带 3857 墨卡托米、
或在分带投影下做自定义重投影）时，可注入自定义 `GeoAdapter`：

```ts
import type { GeoAdapter } from 's3m-maplibre';
import proj4 from 'proj4';

// 把入参（视作 3857 米）反解为真实经纬度，再委托宿主 4547 的 helper
const crsBridge: GeoAdapter = {
  worldFromLngLat(lng, lat, alt = 0) {
    const [lon, latR] = proj4('EPSG:3857', 'EPSG:4326', [lng, lat]);
    const h = map.transform.worldCoordinateHelper;
    const c = h.worldFromLngLat(lon, latR, alt);
    const mpw = h.metersPerWorldUnit?.(c.x, c.y) ?? 1;
    return { x: c.x, y: c.y, z: c.z ?? alt,
             meterInMercatorEast: mpw, meterInMercatorNorth: mpw,
             meterInMercatorUp: mpw, meterInMercator: mpw, altitude: alt };
  },
  lngLatFromWorld(x, y) {
    const ll = map.transform.worldCoordinateHelper.lngLatFromWorld(x, y);
    return proj4('EPSG:4326', 'EPSG:3857', [ll[0], ll[1]]);
  },
};

const layer = new S3MLayer({ configUrl, geo: crsBridge });
// layer.setGeoAdapter(crsBridge);  // 运行时切换
// layer.setGeoAdapter(null);       // 恢复自动推断
```

注入后本层**不再从宿主自动推断投影、也不再在 `projectiontransition` 时自动重建**
适配器——投影变化由你负责响应。`GeoAdapter` 的 `worldFromLngLat(lng, lat)` 输入契约是
**经纬度**，所以「模型是 3857 米」时需在喂入数据前用 proj4 转成真实经纬度（或把 3857 米
塞进数据的经纬度字段再在此反解）。库**不引入 proj4**，换算逻辑完全由你提供。
详见 [docs/API.md](./docs/API.md)。

## 许可

Apache-2.0
