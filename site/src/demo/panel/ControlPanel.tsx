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

      {/* 页面级导航统一由 shared/demo-tabs 挂在顶部，面板里不再重复一份 */}

      <SourceSection />
      <StyleSection />
      <SelectSection />
      <StatsFooter />
    </div>
  );
}
