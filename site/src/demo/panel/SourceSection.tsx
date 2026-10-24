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
        <h2>数据集叠加</h2>
        <div id="datasets" />
      </section>
    </>
  );
}
