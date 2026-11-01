import {
  Heart,
  ListMusic,
  Loader2,
  Moon,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sun,
  AlignLeft,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';
import { useSettingsStore } from '@/app/settings-store';
import { useLikeActions } from '@/features/library/use-like';
import { useRailWidth } from '@/shared/hooks/useRailWidth';
import { cn } from '@/shared/lib/cn';
import { coverVars } from '@/shared/lib/color';
import { formatDuration, singerNames } from '@/shared/lib/format';
import { CoverImage } from '@/shared/ui/CoverImage';
import { ProgressBar } from '@/shared/ui/ProgressBar';
import { DesktopLyricButton } from './DesktopLyricButton';
import { PlayModeButton } from './PlayModeButton';
import { useCurrentSong, usePlayerStore } from './player-store';
import { TrackTime } from './TrackTime';

export function PlayerBar() {
  const song = useCurrentSong();

  const playing = usePlayerStore((s) => s.playing);
  const loading = usePlayerStore((s) => s.loading);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const queueLength = usePlayerStore((s) => s.queue.length);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const seek = usePlayerStore((s) => s.seek);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const setShowQueue = usePlayerStore((s) => s.setShowQueue);
  const setShowNowPlaying = usePlayerStore((s) => s.setShowNowPlaying);

  const theme = useSettingsStore((s) => s.theme);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);

  const volumeRef = useRef<HTMLDivElement>(null);
  const volumeRect = useRef<DOMRect | null>(null);
  const [draggingVolume, setDraggingVolume] = useState(false);

  useRailWidth(volumeRef);

  const { likedMids, toggleLike } = useLikeActions();
  const liked = song ? likedMids.has(song.mid) : false;

  const updateVolume = (clientX: number) => {
    // 拖拽期间复用按下时缓存的几何，不在每次 pointermove 里读布局
    const rect = volumeRect.current;
    if (!rect || rect.width === 0) return;
    setVolume(Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1));
  };

  return (
    <footer className="player">
      <div className="now" style={song ? coverVars(song.mid) : undefined}>
        <button
          type="button"
          className="cover"
          title="打开播放页"
          onClick={() => song && setShowNowPlaying(true)}
          aria-label="打开播放页"
        >
          {song ? <CoverImage src={song.cover} alt={song.name} /> : <span className="g">♫</span>}
        </button>
        <button
          type="button"
          className="meta"
          onClick={() => song && setShowNowPlaying(true)}
        >
          <div className="song">{song ? song.name : '未在播放'}</div>
          <div className="who">
            {song ? `${singerNames(song.singers)} · ${song.albumName || '未知专辑'}` : '选一首歌开始'}
          </div>
        </button>
        <button
          type="button"
          className="like"
          title={liked ? '取消喜欢' : '喜欢'}
          onClick={() => song && void toggleLike(song)}
          disabled={!song}
          style={{ opacity: song ? 1 : 0.3 }}
        >
          <Heart fill={liked ? 'currentColor' : 'none'} strokeWidth={1.8} />
        </button>
      </div>

      <div className="center">
        <div className="controls">
          <PlayModeButton />
          <button type="button" className="icon-btn" title="上一首" onClick={() => void prev()}>
            <SkipBack fill="currentColor" />
          </button>
          <button
            type="button"
            className={cn('ctrl-main', loading && 'loading')}
            title={playing ? '暂停' : '播放'}
            onClick={() => void toggle()}
          >
            {loading ? <Loader2 className="spin" /> : playing ? <Pause /> : <Play />}
          </button>
          <button type="button" className="icon-btn" title="下一首" onClick={() => void next()}>
            <SkipForward fill="currentColor" />
          </button>
          {/* 与左侧模式按钮等宽的占位，保证播放键仍在视觉中心 */}
          <span className="icon-btn ctrl-spacer" aria-hidden="true" />
        </div>

        <div className="progress-row">
          <TrackTime />
          <ProgressBar max={duration || song?.duration || 0} onSeek={seek} />
          <span className="time right">{formatDuration(duration || song?.duration || 0)}</span>
        </div>
      </div>

      <div className="right-controls">
        <button
          type="button"
          className="icon-btn queue-btn"
          title="播放队列"
          onClick={() => setShowQueue(true)}
        >
          <ListMusic />
          {queueLength > 0 ? <span className="badge">{queueLength > 99 ? '99+' : queueLength}</span> : null}
        </button>
        <DesktopLyricButton />
        <button
          type="button"
          className="icon-btn"
          title="播放页歌词"
          onClick={() => song && setShowNowPlaying(true)}
          disabled={!song}
        >
          <AlignLeft />
        </button>

        <div className="volume">
          <button
            type="button"
            className="icon-btn"
            title={muted ? '取消静音' : '静音'}
            onClick={toggleMute}
            style={{ width: 24, height: 24 }}
          >
            {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
          </button>
          <div
            className="vbar"
            ref={volumeRef}
            role="slider"
            aria-label="音量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
            style={{ '--p': String(muted ? 0 : volume) } as CSSProperties}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              volumeRect.current = event.currentTarget.getBoundingClientRect();
              setDraggingVolume(true);
              updateVolume(event.clientX);
            }}
            onPointerMove={(event) => {
              if (draggingVolume) updateVolume(event.clientX);
            }}
            onPointerUp={() => setDraggingVolume(false)}
            onPointerCancel={() => setDraggingVolume(false)}
          >
            <i />
            <span className="vknob" />
          </div>
        </div>

        <button type="button" className="theme-toggle" title="切换主题" onClick={toggleTheme}>
          {theme === 'dark' ? <Moon /> : <Sun />}
          <span className="theme-label">主题</span>
        </button>
      </div>
    </footer>
  );
}
