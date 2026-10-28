/** 着色模式 + 质感与高程 + 地形 + 环境投影 */
export default function StyleSection() {
  return (
    <>
      <section>
        <h2>着色模式</h2>
        <div class="seg" id="modes" />
        <div class="swatches" id="swatches">
          <label id="wrapCA">
            <input type="color" id="cA" value="#dfe6ee" />
            <span id="lblCA">底色</span>
          </label>
          <label id="wrapCB">
            <input type="color" id="cB" value="#1d4ed8" />
            <span id="lblCB">渐变</span>
          </label>
          <label id="wrapCC">
            <input type="color" id="cC" value="#fbbf24" />
            <span id="lblCC">扫描</span>
          </label>
        </div>
        <div id="legend" class="hide" />
      </section>

      <section>
        <h2>质感与高程</h2>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <span style="color:#94a3b8; font-size:11.5px;">深度偏移</span>
          <select id="optPolygonOffset" class="form-select" title="给三角面材质加 polygonOffset：解决跨单体完全共面的重复面（如 BIMbuilding 的 SMID 5136）在深度分辨率边缘出的斜向摩尔纹。mesh 粒度，改动后需重新加载">
            <option value="off" selected>关（默认）</option>
            <option value="near">拉近 (-1, -2)</option>
            <option value="far">推远 (1, 2)</option>
          </select>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <span style="color:#94a3b8; font-size:11.5px;">垂直对齐</span>
          <select id="optAlign" class="form-select">
            <option value="origin" selected>
              原生原点 (Origin)
            </option>
            <option value="top">顶面对齐 (Top·地下工程)</option>
            <option value="bottom">底面对齐 (Bottom·地上建筑)</option>
            <option value="center">中心对齐 (Center)</option>
          </select>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <span style="color:#94a3b8; font-size:11.5px;">材质模型</span>
          <select
            id="optQuality"
            class="form-select"
            title="运行时切换材质模型：原位重建材质，不重拉瓦片。Lambert 光照更便宜，低端设备 / 白模场景更流畅"
          >
            <option value="pbr" selected>PBR（物理光照，默认）</option>
            <option value="lambert">Lambert（低开销）</option>
          </select>
        </div>
        <label class="rng">
          <span>高程调整</span>
          <input type="range" id="optHeightOffset" min="-50" max="50" step="0.5" value="0" />
          <b id="heightOffsetVal">0m</b>
        </label>
        <label class="rng">
          <span>不透明度</span>
          <input type="range" id="optOpacity" min="20" max="100" step="1" value="100" />
          <b id="opacityVal">100%</b>
        </label>
        <label class="rng">
          <span>瓦片淡入</span>
          <input type="range" id="optFadeIn" min="0" max="1200" step="100" value="0" />
          <b id="fadeInVal">关闭</b>
        </label>
        <label
          class="chk"
          title="切换平面/平滑着色：走共享 uniform，不重编译着色器——看底部「着色程序」数保持不变"
        >
          <input type="checkbox" id="optFlat" checked /> 平面着色（白模更干净）
        </label>
        <label class="chk">
          <input type="checkbox" id="optBlendTex" /> 叠加在模型原色贴图上
        </label>
        <label class="rng" id="wrapTexMix" style="display:none; margin-top: 2px;">
          <span>叠加强度</span>
          <input type="range" id="optTexMix" min="10" max="100" step="5" value="80" />
          <b id="texMixVal">80%</b>
        </label>
      </section>

      <section>
        <h2>光照调节 (Lighting)</h2>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <span style="color:#94a3b8; font-size:11.5px;">光照预设</span>
          <select id="optLightPreset" class="form-select" title="supermap：对齐 iClient3D 的观感（暗部压暗、亮部更饱和）。只改光源强度，不动材质与色调映射">
            <option value="default" selected>默认 (PBR)</option>
            <option value="supermap">supermap（对齐官方）</option>
          </select>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <span style="color:#94a3b8; font-size:11.5px;">光照模式</span>
          <select id="optLightMode" class="form-select">
            <option value="headlamp" selected>头灯跟随 (Headlamp)</option>
            <option value="fixed">太阳方位固定 (Fixed)</option>
          </select>
        </div>
        <label class="rng">
          <span>主光强度</span>
          <input type="range" id="optLightMain" min="0" max="250" step="5" value="90" />
          <b id="lightMainVal">0.9</b>
        </label>
        <label class="rng">
          <span>环境光强度</span>
          <input type="range" id="optLightAmbient" min="0" max="200" step="5" value="80" />
          <b id="lightAmbientVal">0.8</b>
        </label>
        <label class="rng">
          <span>高度角 (仰角)</span>
          <input type="range" id="optLightAltitude" min="10" max="90" step="2" value="46" />
          <b id="lightAltitudeVal">46°</b>
        </label>
        <label class="rng">
          <span>方位角 (方向)</span>
          <input type="range" id="optLightAzimuth" min="0" max="360" step="5" value="29" />
          <b id="lightAzimuthVal">29°</b>
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 6px;">
          <span style="color:#94a3b8; font-size:11.5px;">光照颜色</span>
          <div style="display: flex; gap: 10px; align-items: center;">
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: #94a3b8; cursor: pointer;">
              主光
              <input type="color" id="optLightMainColor" value="#ffffff" style="width:20px; height:20px; padding:0; border:none; border-radius:4px; cursor:pointer;" />
            </label>
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: #94a3b8; cursor: pointer;">
              环境
              <input type="color" id="optLightAmbientColor" value="#ffffff" style="width:20px; height:20px; padding:0; border:none; border-radius:4px; cursor:pointer;" />
            </label>
          </div>
        </div>
        <label
          class="chk"
          title="金属度 / 粗糙度走 PBR 材质的共享 uniform（不改材质、不重编译着色器）。金属几乎没有漫反射，没有环境反射时会发黑——先勾上下面那一项"
        >
          <input type="checkbox" id="optPbrSurface" /> 金属质感（Metalness / Roughness）
        </label>
        <div id="wrapPbrSurface" style="display:none">
          <label class="rng" title="0 = 非金属（默认）。越高漫反射越少，金属感越强，同时越依赖环境反射">
            <span>金属度</span>
            <input type="range" id="optMetalness" min="0" max="100" step="1" value="0" />
            <b id="metalnessVal">0.00</b>
          </label>
          <label class="rng" title="越小越接近镜面（下限 0.04），越大越哑光。S3M 数据自身的值由 shininess 映射，常见 0.95">
            <span>粗糙度</span>
            <input type="range" id="optRoughness" min="4" max="100" step="1" value="95" />
            <b id="roughnessVal">0.95</b>
          </label>
          <label class="chk" title="内置天空渐变当环境反射（离线生成，不拉外部 HDR）。关掉时金属度会退回 0，否则整片会发黑">
            <input type="checkbox" id="optEnv" /> 环境反射（天空渐变）
          </label>
        </div>
      </section>

      <section>
        <h2>地形 (MapLibre Terrain)</h2>
        <label class="chk">
          <input type="checkbox" id="optTerrain" /> 开启真实地形（AWS Terrarium DEM）
        </label>
        <label class="rng">
          <span>垂直夸张</span>
          <input type="range" id="optExagg" min="1" max="5" step="0.5" value="1" />
          <b id="exaggVal">1×</b>
        </label>
        <label class="chk">
          <input type="checkbox" id="optTerrainShade" checked /> 地形阴影 (hillshade)
        </label>
        <label class="chk">
          <input type="checkbox" id="optTerrainSnap" checked /> 建筑贴地（自动对齐 DEM 高程）
        </label>
        <div id="terrainInfo" style="font-size:10.5px;color:#64748b;margin-top:4px;">
          未开启
        </div>
      </section>

      <section>
        <h2>环境与投影</h2>
        <label class="chk">
          <input type="checkbox" id="optUnderground" /> 地下透视模式（半透明地表）
        </label>
        <label
          class="chk"
          title="把物理地表当深度遮挡源：地面以下的几何被真正切掉。不需要 DEM 地形，与地下透视互相独立"
        >
          <input type="checkbox" id="optGroundOcclude" /> 地表遮挡（切掉地面以下）
        </label>
        <label class="chk">
          <input type="checkbox" id="optHideBasemap" /> 隐藏地图底图
        </label>
        <label
          class="chk"
          title="叠加矢量瓦片并把 building 层画成 fill-extrusion，用来看 3D 建筑与 S3M 精模同屏的效果"
        >
          <input type="checkbox" id="optVector" /> 矢量底图 + 3D 建筑（MVT）
        </label>
        <input
          type="text"
          id="optVectorUrl"
          placeholder="TileJSON 或 {z}/{x}/{y} 模板，留空用 OpenFreeMap"
          title="矢量瓦片源。免费全球源都在境外，慢的话可以填 MapTiler / 自建 PMTiles / iServer 的地址"
          style="width:100%;margin:-2px 0 6px;font-size:11px"
        />
        <label class="chk" title="只把 S3M 层换成正交：底图仍走 MapLibre 的透视投影，两者差 ≈ 楼高/相机距，所以会把底图退出">
          <input type="checkbox" id="optOrtho" /> 正交 · 仅模型
        </label>
        <label
          class="chk"
          title="接管 MapLibre 的投影矩阵，底图 / 地形 / 标记与模型共用同一个正交相机，底图不必退出。beta，视角不自然，适合俯视"
        >
          <input type="checkbox" id="optOrthoGlobal" /> 正交 · 全局（beta）
        </label>
      </section>
    </>
  );
}
