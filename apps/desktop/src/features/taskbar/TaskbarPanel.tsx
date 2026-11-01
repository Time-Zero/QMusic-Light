import { listen } from '@tauri-apps/api/event';
import { Music2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import {
  bridge,
  IS_TAURI,
  type PlaybackAction,
  type TaskbarLayout,
  type TaskbarSnapshot,
} from '@/bridge';

/** 首帧还没拿到实测比例时先按 100% 缩放的任务栏排布，和 Rust 侧兜底值一致 */
const FALLBACK_LAYOUT: TaskbarLayout = { h: 32, pad: 5, axis: 'horizontal', theme: 'dark' };
const EMPTY: TaskbarSnapshot = { song: null, playing: false, layout: FALLBACK_LAYOUT };

/**
 * 任务栏播放控制面板。
 *
 * 这个窗口不跑路由、不建 Core、不碰音频：它只是主窗口推过来的一份播放态的显示器。
 * 位置、尺寸、横竖、明暗全部由 Rust 侧实测任务栏后下发，这里只负责按 `--tb-h`
 * 等比画出胶囊 —— 因此换分辨率、换缩放、任务栏换边都不会让控件走形。
 */
export function TaskbarPanel() {
  const { song, playing, layout } = usePanelSnapshot();
  // 空串也当作没有封面：`""` 会被解析成当前页面地址，加载失败再回落，白闪一下
  const cover = useStableCover(song?.cover || null);

  useSystemTheme(layout.theme);

  const act = (action: PlaybackAction) => {
    void bridge.taskbar.action(action).catch(() => undefined);
  };

  return (
    <div
      className="tb-root"
      data-axis={layout.axis}
      style={{ '--tb-h': `${layout.h}px`, '--tb-pad': `${layout.pad}px` } as CSSProperties}
      // 右键菜单（刷新 / 检查元素）属于窗口而不是面板，别让它弹在任务栏上
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="tb" role="group" aria-label="任务栏播放控制">
        <button
          type="button"
          className="tb-cover"
          title={song ? `${song.name} · ${song.singers} — 点击打开主界面` : '打开主界面'}
          aria-label="打开主界面"
          onClick={() => void bridge.taskbar.focusMain().catch(() => undefined)}
        >
          {cover ? (
            <img className="tb-cover-img" src={cover} alt="" draggable={false} />
          ) : (
            <Music2 className="tb-cover-icon" />
          )}
        </button>

        <button
          type="button"
          className="tb-btn"
          title="上一首"
          aria-label="上一首"
          onClick={() => act('prev')}
        >
          <SkipBack fill="currentColor" />
        </button>

        <button
          type="button"
          className="tb-btn tb-play"
          title={playing ? '暂停' : '播放'}
          aria-label={playing ? '暂停' : '播放'}
          aria-pressed={playing}
          onClick={() => act('toggle')}
        >
          {playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </button>

        <button
          type="button"
          className="tb-btn"
          title="下一首"
          aria-label="下一首"
          onClick={() => act('next')}
        >
          <SkipForward fill="currentColor" />
        </button>
      </div>
    </div>
  );
}

/** 挂载时补一次完整快照，之后只吃主窗口的增量与平台侧的排布事件 */
function usePanelSnapshot(): TaskbarSnapshot {
  const [snapshot, setSnapshot] = useState<TaskbarSnapshot>(EMPTY);

  useEffect(() => {
    if (!IS_TAURI) return;
    let alive = true;
    // 事件比补读先到：说明补读那一帧更旧，别再拿它盖掉新状态
    let live = false;

    // 先挂监听、再补读。反过来的话，两次 IPC 之间发生的换歌会两头都漏：
    // 补读拿到的是旧帧，事件又没有监听者，面板就一直停在「没有封面」
    const pending = [
      listen<Partial<TaskbarSnapshot>>('taskbar:update', (event) => {
        const payload = event.payload;
        if (!alive || !payload) return;
        live = true;
        // 增量里没有 layout，合并时保住当前排布
        setSnapshot((current) => ({ ...current, ...payload, layout: current.layout }));
      }),
      listen<TaskbarLayout>('taskbar:layout', (event) => {
        const payload = event.payload;
        if (!alive || !payload) return;
        setSnapshot((current) => ({ ...current, layout: payload }));
      }),
    ];

    void bridge.taskbar
      .snapshot()
      .then((value) => {
        if (!alive || !value) return;
        if (!live) setSnapshot((current) => ({ ...current, ...value }));
        // 主题与尺寸此刻已落到 DOM，等一帧让布局生效再让平台侧把窗口显出来
        requestAnimationFrame(() => {
          if (alive) void bridge.taskbar.ready().catch(() => undefined);
        });
      })
      .catch(() => undefined);

    return () => {
      alive = false;
      for (const item of pending) {
        void item.then((off) => off()).catch(() => undefined);
      }
    };
  }, []);

  // 补读失败（平台层还没就绪）也不能把面板永远藏着：兜底报一次到
  useEffect(() => {
    if (!IS_TAURI) return;
    const timer = window.setTimeout(() => {
      void bridge.taskbar.ready().catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  return snapshot;
}

/**
 * 换歌时先把新封面解码好再换上。直接改 `src` 会有一帧空白或旧图，
 * 任务栏这种一眼扫过的地方，闪一下比不换更显眼。
 */
function useStableCover(url: string | null): string | null {
  const [shown, setShown] = useState<string | null>(url);

  useEffect(() => {
    if (url === shown) return;
    if (!url) {
      setShown(null);
      return;
    }
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (alive) setShown(url);
    };
    // 封面 404 / 防盗链：退回默认的渐变底 + 音符，别留一个破图标
    image.onerror = () => {
      if (alive) setShown(null);
    };
    image.src = url;
    return () => {
      alive = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [url, shown]);

  return shown;
}

/** 面板贴在任务栏上，明暗要跟系统走（不是应用内主题），否则会像一块补丁 */
function useSystemTheme(theme: 'light' | 'dark') {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}
