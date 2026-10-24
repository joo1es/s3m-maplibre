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
      </footer>
      <div id="status">
        <span id="dot" />
        <span id="statusText">初始化…</span>
      </div>
    </>
  );
}
