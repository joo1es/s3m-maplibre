/** 底部仪表盘 + 状态灯 */
export default function StatsFooter() {
  return (
    <>
      <footer>
        <div class="stat-chip">
          <span>瓦片</span>
          <b id="stTiles">0</b>
        </div>
        <div class="stat-chip">
          <span>网格</span>
          <b id="stMeshes">0</b>
        </div>
        <div class="stat-chip">
          <span>三角面</span>
          <b id="stTris">0</b>
        </div>
        <div class="stat-chip">
          <span>帧率</span>
          <b id="stFps">—</b>
        </div>
        <div class="stat-chip" title="上一帧 draw call 数">
          <span>Draw Calls</span>
          <b id="stDraws">—</b>
        </div>
        <div class="stat-chip" title="已编译着色程序数：切换平面/平滑着色时它不涨，即零重编译">
          <span>着色程序</span>
          <b id="stPrograms">—</b>
        </div>
        <div class="stat-chip" title="显存驻留纹理数">
          <span>GPU 纹理</span>
          <b id="stTex">—</b>
        </div>
        <div class="stat-chip" title="显存驻留几何数">
          <span>GPU 几何</span>
          <b id="stGeo">—</b>
        </div>
      </footer>
      <div id="status">
        <span id="dot" />
        <span id="statusText">初始化…</span>
      </div>
    </>
  );
}
