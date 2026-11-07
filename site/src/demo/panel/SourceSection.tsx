/** 数据源与数据集叠加：容器由 Solid 渲染，列表内容仍由 initDemo 里的原逻辑填充 */
export default function SourceSection() {
  return (
    <>
      <section>
        <h2>数据源 / URL</h2>
        <div class="url-box">
          <input
            type="text"
            id="urlInput"
            placeholder="输入 .scp 地址或 iServer 服务路径..."
            spellcheck="false"
          />
          <button id="btnLoad" class="btn btn-primary">
            加载
          </button>
        </div>
        <div class="presets" id="presets" />
      </section>

      <section>
        <h2>底图</h2>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <span style="color:#94a3b8; font-size:11.5px;">底图源</span>
          <select
            id="optBasemap"
            class="form-select"
            title="高德 / 腾讯是 GCJ-02（火星坐标），叠 WGS84 的 S3M 模型会整体偏 200~600 米，所以没列进来"
          >
            <option value="tdt">天地图（国内最快·需 key）</option>
            <option value="esri" selected>
              Esri 浅灰（默认·免 key）
            </option>
            <option value="esriStreet">Esri 街道</option>
            <option value="esriImg">Esri 影像</option>
            <option value="osm">OpenStreetMap</option>
            <option value="none">不要底图</option>
          </select>
        </div>
        <div id="tdtKeyRow" style="display: none; margin-bottom: 8px;">
          <input
            type="text"
            id="tdtKey"
            class="form-select"
            style="width: 100%;"
            placeholder="天地图 tk，回车生效（key 后台要配 Referer 白名单）"
            spellcheck="false"
          />
        </div>
      </section>

      <section>
        <h2>数据集叠加</h2>
        <div id="datasets" />
      </section>
    </>
  );
}
