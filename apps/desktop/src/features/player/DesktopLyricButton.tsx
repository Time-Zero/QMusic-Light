import { Captions } from 'lucide-react';
import { useSettingsStore } from '@/app/settings-store';
import { cn } from '@/shared/lib/cn';
import { toggleDesktopLyric } from './use-desktop-lyric';

/**
 * 桌面歌词开关。播放栏右侧与播放页顶栏共用同一个组件：
 * 位置不同，状态同源（settings-store 的 desktopLyric）。
 *
 * 开启：图标染上强调色 + 底色浮起 + 右上角亮起点，
 * 关闭：回到普通图标按钮（灰、透明底）。`aria-pressed` 给读屏同样的信息。
 */
export function DesktopLyricButton({ className }: { className?: string }) {
  const enabled = useSettingsStore((s) => s.desktopLyric);
  const label = enabled ? '关闭桌面歌词' : '开启桌面歌词';

  return (
    <button
      type="button"
      className={cn('icon-btn lyric-toggle', enabled && 'is-on', className)}
      title={enabled ? `${label}（当前已显示）` : `${label}（浮动置顶小窗）`}
      aria-label={label}
      aria-pressed={enabled}
      onClick={() => void toggleDesktopLyric(!enabled)}
    >
      <Captions />
      <span className="lyric-toggle-dot" aria-hidden="true" />
    </button>
  );
}
