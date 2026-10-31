import { QUALITY_LABEL, type Quality } from '@qmusic/shared-types';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ChevronLeft, ChevronRight, LogIn, PanelLeft, Plus, Waves } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAccount } from '@/features/auth/session-store';
import { QUALITY_OPTIONS, useSettingsStore } from '@/app/settings-store';
import { IS_TAURI } from '@/bridge';
import { WindowControls } from '@/shared/components/WindowControls';
import { toast } from '@/shared/ui/ui-store';
import { useUiStore } from '@/shared/ui/ui-store';

/**
 * 这一行同时是标题栏：整行可拖动，右端是窗口按钮，底色与纸面同色。
 */
export function TopBar() {
  const navigate = useNavigate();
  const crumb = useUiStore((s) => s.crumb);
  const account = useAccount();
  const quality = useSettingsStore((s) => s.quality);
  const setQuality = useSettingsStore((s) => s.setQuality);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);

  const cycleQuality = () => {
    const values: Quality[] = QUALITY_OPTIONS.map((option) => option.value);
    const next = values[(values.indexOf(quality) + 1) % values.length];
    setQuality(next);
    toast(`音质已切换为 ${QUALITY_LABEL[next]}`);
  };

  const dragRegion = IS_TAURI ? true : undefined;

  return (
    <header
      className="topbar"
      data-tauri-drag-region={dragRegion}
      onDoubleClick={(event) => {
        if (!IS_TAURI) return;
        if ((event.target as HTMLElement).hasAttribute('data-tauri-drag-region')) {
          void getCurrentWindow().toggleMaximize();
        }
      }}
    >
      <div className="history">
        <button type="button" className="icon-btn" title="后退" onClick={() => navigate(-1)}>
          <ChevronLeft />
        </button>
        <button type="button" className="icon-btn" title="前进" onClick={() => navigate(1)}>
          <ChevronRight />
        </button>
      </div>

      <div className="crumb" data-tauri-drag-region={dragRegion}>
        <b>{crumb || '发现'}</b>
      </div>

      <div className="top-actions">
        <button type="button" className="icon-btn collapse-btn" title="折叠侧栏" onClick={toggleSidebar}>
          <PanelLeft />
        </button>
        <button
          type="button"
          className="pill pill-new"
          onClick={() => toast('新建歌单属于 P2 写接口，当前版本暂未开放')}
        >
          <Plus />
          <span className="pill-label">新建歌单</span>
        </button>
        <button type="button" className="pill pill-quality" onClick={cycleQuality} title="点击切换音质">
          <Waves />
          <span className="pill-label">音质 {QUALITY_LABEL[quality]}</span>
        </button>
        {!account ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/login')}>
            <LogIn />
            扫码登录
          </button>
        ) : null}
        <WindowControls />
      </div>
    </header>
  );
}
