import SourceSection from './SourceSection';
import StyleSection from './StyleSection';
import SelectSection from './SelectSection';
import StatsFooter from './StatsFooter';

/** 左侧主控制面板：只负责结构，交互由 initDemo 里的原逻辑按 id 绑定 */
export default function ControlPanel() {
  return (
    <div id="panel" class="card">
      <div class="brand-bar">
        <div class="brand-title">
          <span class="brand-icon">🏢</span>
          <span>s3m-maplibre</span>
        </div>
        <span class="version-tag" id="versionTag" />
      </div>

      <div class="nav-pills">
        <span class="nav-pill active">🗺️ MapLibre</span>
        <a href="./three.html" class="nav-pill">
          🧊 Three.js 版
        </a>
        <a href="../docs/index.html" class="nav-pill">
          📚 开发文档
        </a>
      </div>

      <SourceSection />
      <StyleSection />
      <SelectSection />
      <StatsFooter />
    </div>
  );
}
