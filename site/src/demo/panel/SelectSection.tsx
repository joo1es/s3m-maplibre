/** 选中高亮 + 单体过滤 + 按业务字段着色/过滤/抬高 */
export default function SelectSection() {
  return (
    <>
      <section>
        <h2>选中与高亮</h2>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <span style="color:#94a3b8; font-size:11.5px;">高亮模式</span>
          <select id="optSelMode" class="form-select">
            <option value="overlay" selected>
              叠加原图 (Overlay)
            </option>
            <option value="replace">纯色覆盖 (Replace)</option>
            <option value="multiply">叠乘模式 (Multiply)</option>
            <option value="glowOnly">仅描边发光 (Glow)</option>
          </select>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <span style="color:#94a3b8; font-size:11.5px;">高亮颜色</span>
          <input
            type="color"
            id="optSelColor"
            value="#22d3ee"
            style="width:26px; height:20px; border:1px solid rgba(255,255,255,0.2); border-radius:4px; padding:0; cursor:pointer; background:none;"
          />
        </div>
        <label class="rng" id="wrapSelOpacity">
          <span>叠色浓度</span>
          <input type="range" id="optSelOpacity" min="10" max="100" step="5" value="65" />
          <b id="selOpacityVal">65%</b>
        </label>
        <label class="rng">
          <span>单体拔高</span>
          <input type="range" id="optSelElevation" min="0" max="40" step="1" value="0" />
          <b id="selElevationVal">0m</b>
        </label>
        <label class="chk">
          <input type="checkbox" id="optOutline" checked /> 选中单体描边
        </label>
        <div id="wrapOutlineOpts" style="margin: 2px 0 6px 18px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span style="color:#94a3b8; font-size:11px;">画法</span>
            <select id="optOutlineStyle" class="form-select" style="padding: 2px 5px; font-size: 11px;">
              <option value="edges" selected>
                棱线（单体折边）
              </option>
              <option value="hull">外扩轮廓</option>
            </select>
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
            <span style="color:#94a3b8; font-size:11px;">描边颜色</span>
            <input
              type="color"
              id="optOutlineColor"
              value="#22d3ee"
              style="width:24px; height:18px; border:1px solid rgba(255,255,255,0.2); border-radius:4px; padding:0; cursor:pointer; background:none;"
            />
          </div>
          <label class="rng" id="wrapOutlineWidthPx" style="padding:0;">
            <span style="font-size:11px;">棱线粗细</span>
            <input type="range" id="optOutlineWidthPx" min="10" max="80" step="5" value="30" />
            <b id="outlineWidthPxVal">3.0px</b>
          </label>
          <label class="rng" id="wrapOutlineWidth" style="padding:0; display:none;">
            <span style="font-size:11px;">外扩粗细</span>
            <input type="range" id="optOutlineWidth" min="2" max="30" step="1" value="9" />
            <b id="outlineWidthVal">0.9m</b>
          </label>
        </div>
        <label class="chk">
          <input type="checkbox" id="optDim" checked /> 选中时压暗其他
        </label>
        <label class="chk">
          <input type="checkbox" id="optEdges" /> 全局棱线
        </label>
        <label class="rng" id="wrapEdgeOpacity" style="display:none; margin-top: 4px;">
          <span>棱线透明度</span>
          <input type="range" id="optEdgeOpacity" min="10" max="100" step="5" value="45" />
          <b id="edgeOpacityVal">45%</b>
        </label>
        <label class="rng" id="wrapEdgeWidth" style="display:none; margin-top: 4px;">
          <span>棱线粗细</span>
          <input type="range" id="optEdgeWidth" min="10" max="60" step="5" value="12" />
          <b id="edgeWidthVal">1.2px</b>
        </label>
        <label class="rng" id="wrapEdgeThreshold" style="display:none; margin-top: 4px;">
          <span>棱线临界角</span>
          <input type="range" id="optEdgeThreshold" min="5" max="120" step="5" value="55" />
          <b id="edgeThresholdVal">55°</b>
        </label>
        <label class="chk">
          <input type="checkbox" id="optOccludeBack" checked /> 遮挡内部与背面线条 (深度防透)
        </label>
      </section>

      <section>
        <h2>单体过滤与筛选 (Filter)</h2>
        <div style="display: flex; gap: 5px; margin-bottom: 6px;">
          <button id="btnFilterIsolate" class="btn" style="flex:1;">
            仅看选中
          </button>
          <button id="btnFilterHide" class="btn btn-danger" style="flex:1;">
            隐藏选中
          </button>
          <button id="btnFilterReset" class="btn" style="flex:1;">
            恢复全显
          </button>
        </div>
        <label class="rng">
          <span>高度上限</span>
          <input type="range" id="optFilterMaxH" min="10" max="250" step="5" value="250" />
          <b id="filterMaxHVal">全部</b>
        </label>
        <div id="filterStatus" style="font-size: 11px; color: #64748b; margin-top: 3px; min-height: 16px;" />
      </section>

      <section>
        <h2>单体动画（演示）</h2>
        <div style="display: flex; gap: 5px; margin-bottom: 6px;">
          <button id="btnOrbit" class="btn" style="flex:1;">
            选中单体绕圈
          </button>
          <button id="btnOrbitStop" class="btn" style="flex:1;">
            停止
          </button>
        </div>
        <div style="display: flex; gap: 5px; margin-bottom: 6px;">
          <button id="btnTurn" class="btn" style="flex:1;">
            方形回路（四个直角弯）
          </button>
          <button id="btnTurnStop" class="btn" style="flex:1;">
            解绑回路
          </button>
        </div>
        <div style="display: flex; gap: 5px;">
          <button id="btnRaise" class="btn" style="flex:1;">
            抬高 100m
          </button>
          <button id="btnFadeOut" class="btn" style="flex:1;">
            淡出 / 淡入
          </button>
        </div>
        <div id="animStatus" style="font-size: 11px; color: #64748b; margin-top: 3px; min-height: 16px;" />
      </section>

      <section>
        <h2>按业务字段（着色 / 过滤 / 抬高）</h2>
        <input
          id="optAttrUrl"
          type="text"
          class="form-input"
          placeholder="数据服务地址 .../rest/data"
          style="width: 100%; margin-bottom: 5px;"
        />
        <div style="display: flex; gap: 5px; margin-bottom: 5px;">
          <input
            id="optAttrDataset"
            type="text"
            class="form-input"
            placeholder="DataSource:zhoubian"
            style="flex: 1; min-width: 0;"
          />
          <button id="btnAttrFields" class="btn">
            读字段
          </button>
        </div>
        <div style="display: flex; gap: 5px; margin-bottom: 5px;">
          <select id="optAttrField" class="form-select" style="flex: 1; min-width: 0;">
            <option value="">先点「读字段」</option>
          </select>
          <select id="optAttrType" class="form-select">
            <option value="category" selected>
              分类
            </option>
            <option value="ramp">渐变</option>
            <option value="breaks">分级</option>
          </select>
        </div>
        <div style="display: flex; gap: 5px;">
          <button id="btnAttrApply" class="btn btn-primary" style="flex: 1;">
            按字段上色
          </button>
          <button id="btnAttrClear" class="btn">
            清除
          </button>
        </div>
        <div
          id="attrLegend"
          style="margin-top: 6px; font-size: 11px; color: #cbd5e1; max-height: 132px; overflow-y: auto;"
        />
        <div id="attrStatus" style="font-size: 11px; color: #64748b; margin-top: 3px; min-height: 16px;" />

        <div style="margin-top: 8px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.08);">
          <div style="font-size: 11px; color: #64748b; margin-bottom: 4px;">
            过滤区间（数值字段，留空为不限）
          </div>
          <div style="display: flex; gap: 5px; margin-bottom: 5px;">
            <input id="optAttrMin" type="number" class="form-input" placeholder="min" style="flex: 1; min-width: 0;" />
            <input id="optAttrMax" type="number" class="form-input" placeholder="max" style="flex: 1; min-width: 0;" />
            <select id="optAttrFilterMode" class="form-select">
              <option value="keep" selected>
                保留匹配
              </option>
              <option value="hide">隐藏匹配</option>
            </select>
          </div>
          <div style="display: flex; gap: 5px; margin-bottom: 7px;">
            <button id="btnAttrFilter" class="btn btn-primary" style="flex: 1;">
              按字段过滤
            </button>
            <button id="btnAttrFilterClear" class="btn">
              全部显示
            </button>
          </div>
          <div style="font-size: 11px; color: #64748b; margin-bottom: 4px;">
            抬高倍率（米 / 字段单位）
          </div>
          <div style="display: flex; gap: 5px;">
            <input id="optAttrElev" type="number" step="0.5" value="1" class="form-input" style="width: 70px;" />
            <button
              id="btnAttrElevate"
              class="btn"
              style="flex: 1; border-color: rgba(16, 185, 129, 0.4); background: rgba(16, 185, 129, 0.12); color: #34d399;"
            >
              按字段抬高
            </button>
            <button id="btnAttrElevReset" class="btn">
              复位
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
