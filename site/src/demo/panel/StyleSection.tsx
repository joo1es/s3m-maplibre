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
        <label class="chk">
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
        <label class="chk">
          <input type="checkbox" id="optHideBasemap" /> 隐藏地图底图
        </label>
        <label class="chk">
          <input type="checkbox" id="optOrtho" /> 正交投影（工程俯视/轴测）
        </label>
      </section>
    </>
  );
}
