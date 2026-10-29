import { useQuery } from '@tanstack/react-query';
import { TTL, activeLineIndex } from '@core';
import type { LyricLine } from '@qmusic/shared-types';
import { QUALITY_LABEL } from '@qmusic/shared-types';
import {
  ChevronDown,
  Heart,
  ListMusic,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useAccount } from '@/features/auth/session-store';
import { useSettingsStore } from '@/app/settings-store';
import { IS_TAURI } from '@/bridge';
import { WindowControls } from '@/shared/components/WindowControls';
import { cn } from '@/shared/lib/cn';
import { coverPalette, extractPalette } from '@/shared/lib/color';
import { formatDuration, singerNames } from '@/shared/lib/format';
import { allowsDecoration } from '@/shared/lib/motion-mode';
import { subscribeProgress } from '@/shared/lib/progress-driver';
import { CoverImage } from '@/shared/ui/CoverImage';
import { ProgressBar } from '@/shared/ui/ProgressBar';
import { toast } from '@/shared/ui/ui-store';
import { useCurrentSong, usePlayerStore } from './player-store';
import { TrackTime } from './TrackTime';

interface LyricListProps {
  lines: LyricLine[];
  onSeek: (time: number) => void;
}

/**
 * 歌词列表：高亮与跟随全部命令式完成，React 只在"换歌（lines 变化）"时参与。
 *
 * 跟随不用 scrollIntoView({behavior:'smooth'})：嵌套滚动容器里的平滑滚动由主线程
 * 逐帧驱动，正好和进度更新抢同一帧。这里改成"滚动位置瞬移 + 反向位移补间"，
 * 位移交给合成器插值，主线程只在歌词换行时干一次活。
 */
const LyricList = memo(function LyricList({ lines, onSeek }: LyricListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(-1);
  const manualUntil = useRef(0);

  // 换歌词：回到顶部并清掉残留位移，避免上一首的补间串到下一首
  useLayoutEffect(() => {
    activeRef.current = -1;
    manualUntil.current = 0;
    const scroll = scrollRef.current;
    const track = trackRef.current;
    if (scroll) scroll.scrollTop = 0;
    if (track) {
      track.style.transition = 'none';
      track.style.transform = 'translate3d(0, 0, 0)';
      void track.offsetHeight;
      track.style.transition = '';
      track.style.transform = '';
    }
  }, [lines]);

  // layout effect：打开播放页时首帧就落在当前句上，不会先显示顶部再跳
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const track = trackRef.current;
    if (!scroll || !track || lines.length === 0) return;

    const items = Array.from(track.querySelectorAll<HTMLElement>('.lyric-line'));
    const animated = allowsDecoration();

    return subscribeProgress(({ seconds }) => {
      const index = activeLineIndex(lines, seconds);
      if (index === activeRef.current) return;

      const previous = activeRef.current;
      activeRef.current = index;
      if (previous >= 0) items[previous]?.classList.remove('active');

      const node = index >= 0 ? items[index] : undefined;
      if (!node) return;
      node.classList.add('active');

      // 用户刚手动滚过就先不抢：高亮继续走，位置留给他
      if (Date.now() < manualUntil.current) return;

      const center = node.offsetTop + node.offsetHeight / 2 - scroll.clientHeight / 2;
      const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const next = Math.max(0, Math.min(center, max));
      const from = scroll.scrollTop;
      if (Math.abs(next - from) < 1) return;

      scroll.scrollTop = next;
      // 跨度过大（例如点了很远的行）直接跳，补间反而像故障
      if (!animated || Math.abs(from - next) > scroll.clientHeight * 0.9) return;

      // 先把轨道按"仍停在原位"的偏移量顶回去，再让合成器把偏移补间到 0。
      // 位移量 = 新滚动位置 - 旧滚动位置（内容视图需要反向补偿这么多）。
      track.style.transition = 'none';
      track.style.transform = `translate3d(0, ${next - from}px, 0)`;
      void track.offsetHeight;
      track.style.transition = '';
      track.style.transform = '';
    });
  }, [lines]);

  const holdFollow = () => {
    manualUntil.current = Date.now() + 4000;
  };

  return (
    <div className="np-lyrics" ref={scrollRef} onWheel={holdFollow} onTouchStart={holdFollow}>
      <div className="np-lyric-track" ref={trackRef}>
        {lines.map((line, index) => (
          <div
            key={`${line.time}-${index}`}
            className="lyric-line"
            onClick={() => onSeek(line.time)}
            role="button"
            tabIndex={-1}
          >
            {line.text || '♪'}
            {line.trans ? <span className="trans">{line.trans}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
});

export function NowPlaying({ closing = false }: { closing?: boolean }) {
  const core = useCore();
  const navigate = useNavigate();
  const account = useAccount();
  const song = useCurrentSong();

  const playing = usePlayerStore((s) => s.playing);
  const loading = usePlayerStore((s) => s.loading);
  const duration = usePlayerStore((s) => s.duration);
  const mode = usePlayerStore((s) => s.mode);
  const quality = usePlayerStore((s) => s.streamQuality);
  const setShowNowPlaying = usePlayerStore((s) => s.setShowNowPlaying);
  const setShowQueue = usePlayerStore((s) => s.setShowQueue);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const seek = usePlayerStore((s) => s.seek);
  const setMode = usePlayerStore((s) => s.setMode);
  const cycleMode = usePlayerStore((s) => s.cycleMode);
  const preferredQuality = useSettingsStore((s) => s.quality);

  const [palette, setPalette] = useState(() => coverPalette(song?.mid ?? ''));
  const [liked, setLiked] = useState(false);

  const lyric = useQuery({
    queryKey: ['lyric', song?.mid],
    queryFn: () => core.songs.lyric(song!),
    enabled: Boolean(song),
    staleTime: TTL.lyric,
    retry: 1,
  });

  const lines = lyric.data?.lines ?? [];
  const plainLines = useMemo(() => {
    const raw = lyric.data?.lrc ?? '';
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }, [lyric.data?.lrc]);

  useEffect(() => {
    if (!song) return;
    let alive = true;
    void extractPalette(song.cover, song.mid).then((value) => {
      if (alive) setPalette(value);
    });
    return () => {
      alive = false;
    };
  }, [song?.mid, song?.cover]);

  useEffect(() => {
    if (!song) return;
    let alive = true;
    void core.repo
      .isLiked(song.mid)
      .then((value) => alive && setLiked(value))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [core, song?.mid]);

  if (!song) return null;

  const like = async () => {
    if (!account) {
      setShowNowPlaying(false);
      navigate('/login');
      return;
    }
    try {
      if (liked) await core.playlists.removeLike(account, song);
      else await core.playlists.addLike(account, song);
      const value = !liked;
      setLiked(value);
      void core.repo.setLiked(song.mid, value);
      toast(value ? '已加入我喜欢的音乐' : '已取消喜欢', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', 'error');
    }
  };

  return (
    <section
      className={cn('nowplaying', closing && 'is-closing')}
      style={{ '--cover-a': palette.c1, '--cover-b': palette.c2 } as React.CSSProperties}
      aria-label="正在播放"
      inert={closing || undefined}
    >
      <div className="np-top" data-tauri-drag-region={IS_TAURI ? true : undefined}>
        <button
          type="button"
          className="icon-btn"
          title="收起"
          onClick={() => setShowNowPlaying(false)}
        >
          <ChevronDown />
        </button>
        <span className="np-title">正在播放</span>
        <span className="spacer" />
        <span className="playing-badge">
          <Volume2 />
          {QUALITY_LABEL[quality ?? preferredQuality]}
        </span>
        <button
          type="button"
          className="icon-btn"
          title="播放队列"
          onClick={() => setShowQueue(true)}
        >
          <ListMusic />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="更多"
          onClick={() => toast('分享 / 评论属于 P2 扩展，当前版本暂未开放')}
        >
          <MoreHorizontal />
        </button>
        <WindowControls />
      </div>

      <div className="np-body">
        <div className="np-cover">
          <CoverImage src={song.cover} alt={song.name} glyph="♫" />
        </div>

        <div className="np-info">
          <div className="kicker">NOW PLAYING · {song.albumName || '未知专辑'}</div>
          <h1>{song.name}</h1>
          <div className="sub">
            {singerNames(song.singers)}
            {song.payPlay === 1 ? ' · VIP 曲目（不绕过付费限制）' : ''}
          </div>

          {lyric.isLoading ? (
            <div className="np-lyrics">
              <div className="lyric-empty">歌词加载中…</div>
            </div>
          ) : lines.length > 0 ? (
            <LyricList lines={lines} onSeek={seek} />
          ) : plainLines.length > 0 ? (
            <div className="np-lyrics">
              <div className="np-lyric-track">
                {plainLines.map((line, index) => (
                  <div key={`${line}-${index}`} className="lyric-line static">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="np-lyrics">
              <div className="lyric-empty">
                {lyric.isError ? '歌词获取失败，稍后重试' : '暂无歌词，纯音乐请欣赏'}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="np-progress">
        <div className="progress-row">
          <TrackTime />
          <ProgressBar max={duration || song.duration || 0} onSeek={seek} />
          <span className="time right">{formatDuration(duration || song.duration || 0)}</span>
        </div>
        <div className="np-controls">
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
      </div>

      <div className="np-aside">
        <button
          type="button"
          className="icon-btn"
          title={liked ? '取消喜欢' : '喜欢'}
          onClick={() => void like()}
          style={{ color: liked ? '#f2555a' : undefined }}
        >
          <Heart fill={liked ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="播放队列"
          onClick={() => setShowQueue(true)}
        >
          <ListMusic />
        </button>
      </div>
    </section>
  );
}
