import { useEffect, useLayoutEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { CommandPalette } from '@/features/player/CommandPalette';
import { NowPlaying } from '@/features/player/NowPlaying';
import { PlayerBar } from '@/features/player/PlayerBar';
import { QueuePanel } from '@/features/player/QueuePanel';
import { usePlayerStore } from '@/features/player/player-store';
import { useDesktopLyric } from '@/features/player/use-desktop-lyric';
import { useShellBridge } from '@/features/player/use-shell-bridge';
import { useTaskbarPanel } from '@/features/taskbar/use-taskbar-panel';
import { Sidebar } from '@/shared/components/Sidebar';
import { TopBar } from '@/shared/components/TopBar';
import { useGlobalHotkeys } from '@/shared/hooks/useGlobalHotkeys';
import { usePresence } from '@/shared/hooks/usePresence';
import { ToastHost } from '@/shared/ui/ToastHost';
import { useSettingsStore } from './settings-store';

export function AppShell() {
  const collapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const showNowPlaying = usePlayerStore((s) => s.showNowPlaying);
  const showQueue = usePlayerStore((s) => s.showQueue);
  const location = useLocation();

  useGlobalHotkeys();
  useShellBridge();
  // 桌面歌词浮窗的唯一数据源：换歌 / 换行 / 播放态都从这里推过去
  useDesktopLyric();
  // 任务栏面板只要封面与播放态，换歌 / 暂停时推一次就够
  useTaskbarPanel();

  const nowPlaying = usePresence(showNowPlaying);
  const queue = usePresence(showQueue);

  // 路由切换在绘制前复位滚动，避免新页面先以旧滚动位置闪一帧；
  // 用 instant 覆盖 .content 的 scroll-behavior: smooth，入场动画不该被滚动抢走注意力。
  useLayoutEffect(() => {
    document.getElementById('content-scroll')?.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname]);

  // 窗口失焦时暂停非必要动画（频谱 / 呼吸灯），降低空闲 CPU（文档 §7.7）
  useEffect(() => {
    const onBlur = () => {
      document.documentElement.dataset.windowFocus = 'blurred';
    };
    const onFocus = () => {
      delete document.documentElement.dataset.windowFocus;
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return (
    <>
      <div className="app" data-collapsed={collapsed}>
        <Sidebar />
        <div className="workspace">
          <TopBar />
          <div className="content" id="content-scroll">
            <div className="content-body">
              {/* key 让每次换页重新挂载，入场动画只在路由切换时播放一次 */}
              <div className="page" key={location.pathname}>
                <Outlet />
              </div>
            </div>
          </div>
        </div>
      </div>

      <PlayerBar />
      {nowPlaying.mounted ? <NowPlaying closing={nowPlaying.closing} /> : null}
      {queue.mounted ? <QueuePanel closing={queue.closing} /> : null}
      <CommandPalette />
      <ToastHost />
    </>
  );
}
