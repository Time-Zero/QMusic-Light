import { useMutation } from '@tanstack/react-query';
import {
  Heart,
  ListMusic,
  Loader2,
  Moon,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Sun,
  AlignLeft,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useSettingsStore } from '@/app/settings-store';
import { useAccount } from '@/features/auth/session-store';
import { useRailWidth } from '@/shared/hooks/useRailWidth';
import { cn } from '@/shared/lib/cn';
import { coverVars } from '@/shared/lib/color';
import { formatDuration, singerNames } from '@/shared/lib/format';
import { CoverImage } from '@/shared/ui/CoverImage';
import { ProgressBar } from '@/shared/ui/ProgressBar';
import { toast } from '@/shared/ui/ui-store';
import { useCurrentSong, usePlayerStore } from './player-store';
import { TrackTime } from './TrackTime';

export function PlayerBar() {
  const core = useCore();
  const navigate = useNavigate();
  const account = useAccount();
  const song = useCurrentSong();

  const playing = usePlayerStore((s) => s.playing);
  const loading = usePlayerStore((s) => s.loading);
  const duration = usePlayerStore((s) => s.duration);
  const mode = usePlayerStore((s) => s.mode);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const queueLength = usePlayerStore((s) => s.queue.length);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const seek = usePlayerStore((s) => s.seek);
  const setMode = usePlayerStore((s) => s.setMode);
  const cycleMode = usePlayerStore((s) => s.cycleMode);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const setShowQueue = usePlayerStore((s) => s.setShowQueue);
  const setShowNowPlaying = usePlayerStore((s) => s.setShowNowPlaying);

  const theme = useSettingsStore((s) => s.theme);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);

  const [liked, setLiked] = useState(false);
  const volumeRef = useRef<HTMLDivElement>(null);
  const volumeRect = useRef<DOMRect | null>(null);
  const [draggingVolume, setDraggingVolume] = useState(false);

  useRailWidth(volumeRef);

  useEffect(() => {
    if (!song) {
      setLiked(false);
      return;
    }
    let alive = true;
    void core.repo
      .isLiked(song.mid)
      .then((value) => alive && setLiked(value))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [core, song?.mid]);

  const likeMutation = useMutation({
    mutationFn: async () => {
      if (!account || !song) throw new Error('需要登录');
      if (liked) await core.playlists.removeLike(account, song);
      else await core.playlists.addLike(account, song);
    },
    onSuccess: () => {
      const nextLiked = !liked;
      setLiked(nextLiked);
      if (song) void core.repo.setLiked(song.mid, nextLiked);
      toast(nextLiked ? '已加入我喜欢的音乐' : '已取消喜欢', 'success');
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : '操作失败', 'error');
    },
  });

  const onToggleLike = () => {
    if (!account) {
      toast('登录后才能收藏歌曲');
      navigate('/login');
      return;
    }
    if (!song) return;
    likeMutation.mutate();
  };

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
          onClick={onToggleLike}
          disabled={!song}
          style={{ opacity: song ? 1 : 0.3 }}
        >
          <Heart fill={liked ? 'currentColor' : 'none'} strokeWidth={1.8} />
        </button>
      </div>

      <div className="center">
        <div className="controls">
          <button
            type="button"
            className={cn('icon-btn', mode === 'shuffle' && 'is-active')}
            title="随机播放"
            onClick={() => setMode(mode === 'shuffle' ? 'order' : 'shuffle')}
          >
            <Shuffle />
          </button>
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
          <button
            type="button"
            className={cn('icon-btn', mode === 'single' && 'is-active')}
            title={mode === 'single' ? '单曲循环' : '顺序播放'}
            onClick={cycleMode}
          >
            {mode === 'single' ? <Repeat1 /> : <Repeat />}
          </button>
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
        <button
          type="button"
          className="icon-btn"
          title="歌词"
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
            style={{ width: 22, height: 22 }}
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
          主题
        </button>
      </div>
    </footer>
  );
}
