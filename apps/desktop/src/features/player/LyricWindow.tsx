import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { bridge, IS_TAURI, type LyricSnapshot } from '@/bridge';
import { cn } from '@/shared/lib/cn';

const EMPTY: LyricSnapshot = { song: null, lines: [], index: -1, playing: false };

/**
 * 桌面浮动歌词窗口。
 *
 * 这个窗口不跑路由、不建 Core、不碰音频：它只是主窗口推过来的一份快照的显示器。
 * 歌词本身、当前行、播放态都由主窗口算好（Rust 侧合并转发），
 * 因此暂停时歌词停在原处、切歌时整条立刻换掉，不会和播放条对不上。
 */
export function LyricWindow() {
  const [snapshot, setSnapshot] = useState<LyricSnapshot>(EMPTY);

  useSnapshot(setSnapshot);
  usePersistPosition();

  const { song, lines, index, playing } = snapshot;
  const current = index >= 0 ? lines[index] : undefined;
  // 还没进第一句时先预告第一句，方便用户知道歌词确实对上了
  const upcoming = index >= 0 ? lines[index + 1] : lines[0];
  // 纯音乐 / 无歌词：退化成「歌名 + 暂无歌词」，不至于整条空着
  const headline = song ? current?.text?.trim() || (current ? '♪' : song.name) : '等待播放';
  const secondary = song
    ? upcoming?.text?.trim() || (lines.length === 0 ? '暂无歌词' : '')
    : '在播放栏或播放页点亮「桌面歌词」';
  const detail = song ? [song.name, song.singers].filter(Boolean).join(' · ') : '桌面歌词';

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!IS_TAURI || event.button !== 0) return;
    // 按钮要能点，只有空白处才当作拖动手柄
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    void getCurrentWindow()
      .startDragging()
      .catch(() => undefined);
  };

  return (
    <div className="dl-root" title={detail} onPointerDown={beginDrag}>
      <div
        className={cn('dl', !song && 'is-idle', song && !playing && 'is-paused')}
        role="group"
        aria-label="桌面歌词"
      >
        <span className="dl-flag" aria-hidden="true">
          {song && !playing ? <Pause /> : <i className="dl-dot" />}
        </span>

        <div className="dl-text">
          <div className="dl-current" key={`${song?.name ?? ''}#${index}`}>
            {headline}
          </div>
          <div className="dl-next">{secondary}</div>
        </div>

        <div className="dl-tools">
          <button
            type="button"
            className="dl-btn"
            title="上一首"
            onClick={() => void bridge.lyric.action('prev')}
          >
            <SkipBack fill="currentColor" />
          </button>
          <button
            type="button"
            className="dl-btn"
            title={playing ? '暂停' : '播放'}
            onClick={() => void bridge.lyric.action('toggle')}
          >
            {playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
          </button>
          <button
            type="button"
            className="dl-btn"
            title="下一首"
            onClick={() => void bridge.lyric.action('next')}
          >
            <SkipForward fill="currentColor" />
          </button>
          <button
            type="button"
            className="dl-btn dl-close"
            title="关闭桌面歌词"
            onClick={() => void bridge.lyric.setEnabled(false).catch(() => undefined)}
          >
            <X />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 首次挂载补一次完整快照，之后只吃主窗口的增量广播 */
function useSnapshot(apply: (value: LyricSnapshot) => void) {
  useEffect(() => {
    if (!IS_TAURI) return;
    let alive = true;
    void bridge.lyric
      .snapshot()
      .then((value) => {
        if (alive && value) apply(value);
      })
      .catch(() => undefined);

    const pending = listen<LyricSnapshot>('lyric:update', (event) => {
      if (alive && event.payload) apply(event.payload);
    });

    return () => {
      alive = false;
      void pending.then((off) => off()).catch(() => undefined);
    };
  }, [apply]);
}

/**
 * 记住用户把浮窗拖到哪儿了。窗口还能跨屏拖动，
 * 所以存的是物理像素，落盘前由 Rust 侧再做一次可视区夹取。
 */
function usePersistPosition() {
  useEffect(() => {
    if (!IS_TAURI) return;
    const window_ = getCurrentWindow();
    let timer = 0;
    let ready = false;
    // 创建时的默认摆位也会触发 Moved，等它落定之后才开始记
    const arm = window.setTimeout(() => {
      ready = true;
    }, 900);

    const pending = window_.onMoved(({ payload }) => {
      if (!ready) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void bridge.lyric.persistPos({ x: payload.x, y: payload.y }).catch(() => undefined);
      }, 400);
    });

    return () => {
      window.clearTimeout(arm);
      window.clearTimeout(timer);
      void pending.then((off) => off()).catch(() => undefined);
    };
  }, []);
}
