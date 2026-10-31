import { useQuery } from '@tanstack/react-query';
import { TTL } from '@core';
import type { Song } from '@qmusic/shared-types';
import { CalendarDays, LogIn, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useAccount } from '@/features/auth/session-store';
import { useLikeActions } from '@/features/library/use-like';
import { usePlayerStore } from '@/features/player/player-store';
import { coverVars } from '@/shared/lib/color';
import { formatDateCN, formatTotalDuration, formatWeekday, todayKey } from '@/shared/lib/format';
import { CoverImage } from '@/shared/ui/CoverImage';
import { EmptyState } from '@/shared/ui/EmptyState';
import { TracksSkeleton } from '@/shared/ui/Skeleton';
import { TrackTable } from '@/shared/ui/TrackTable';
import { useUiStore } from '@/shared/ui/ui-store';

export default function DailyPage() {
  const core = useCore();
  const navigate = useNavigate();
  const account = useAccount();
  const setCrumb = useUiStore((s) => s.setCrumb);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const playingMid = usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index]?.mid : undefined));
  const playing = usePlayerStore((s) => s.playing);

  useEffect(() => setCrumb('发现 / 每日 30 首'), [setCrumb]);

  const daily = useQuery({
    queryKey: ['daily', account?.uin],
    queryFn: () => core.feed.daily(account!),
    enabled: Boolean(account),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const detail = useQuery({
    queryKey: ['daily-detail', daily.data?.playlistId],
    queryFn: () =>
      core.playlists.detail(daily.data!.playlistId, { kind: 'daily', account: account!, num: 30 }),
    enabled: Boolean(daily.data?.playlistId && account),
    staleTime: TTL.playlistDetail,
    retry: 0,
  });

  const [cachedSongs, setCachedSongs] = useState<Song[]>([]);

  useEffect(() => {
    if (!daily.data || daily.data.songs.length === 0) return;
    void core.repo.saveDaily(daily.data.day, daily.data.songs).catch(() => undefined);
  }, [daily.data, core]);

  useEffect(() => {
    if (!daily.isError) {
      setCachedSongs([]);
      return;
    }
    let alive = true;
    void core.repo
      .loadDaily(todayKey())
      .then((songs) => alive && setCachedSongs(songs))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [daily.isError, core]);

  const songs = daily.data?.songs ?? cachedSongs;
  const { likedMids, toggleLike } = useLikeActions(songs);

  if (!account) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">每日 30 首</h1>
            <p className="page-sub">每天 0 点更新，根据你的红心与最近播放生成</p>
          </div>
        </div>
        <EmptyState
          icon={<CalendarDays />}
          title="登录后查看每日 30 首"
          description="QQ 音乐的每日推荐由推荐流下发，必须使用登录态。扫码后即可同步。"
          action={
            <button type="button" className="btn btn-primary" onClick={() => navigate('/login')}>
              <LogIn />
              扫码登录
            </button>
          }
        />
      </div>
    );
  }

  const playlist = detail.data?.playlist;
  const totalDuration = songs.reduce((sum, song) => sum + song.duration, 0);
  const fromCache = Boolean(daily.isError && cachedSongs.length > 0);

  return (
    <div>
      <section className="hero" style={coverVars(playlist?.id ?? 'daily')}>
        <div className="hero-cover">
          {playlist?.cover ? <CoverImage src={playlist.cover} alt="每日 30 首" /> : <span className="glyph">♫</span>}
        </div>
        <div className="hero-body">
          <div className="hero-kicker">
            <span className="live" />
            DAILY MIX · {formatDateCN()} {formatWeekday()}
          </div>
          <h1>每日 30 首</h1>
          <div className="hero-meta">
            <span>根据你的红心与最近播放生成</span>
            <i />
            <span>{songs.length || 30} 首</span>
            <i />
            <span>{formatTotalDuration(totalDuration)}</span>
          </div>
          {playlist?.description ? <p className="hero-desc">{playlist.description}</p> : null}
          <div className="hero-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={songs.length === 0}
              onClick={() => void playQueue(songs, 0, '每日 30 首')}
            >
              <Play />
              播放全部
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void daily.refetch()}>
              <RefreshCw />
              重新获取
            </button>
          </div>
        </div>
        <div className="hero-aside">
          <div className="lab">今日推荐</div>
          <div className="chips">
            {(playlist?.tags ?? ['华语流行', '独立电子', 'City Pop']).slice(0, 3).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
          <div className="streak">
            <b>{songs.length}</b>首 · 每日 0 点刷新
          </div>
        </div>
      </section>

      {daily.isError ? (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <TriangleAlert />
          {fromCache
            ? `网络异常，展示今日本地缓存（${cachedSongs.length} 首）。`
            : `每日 30 首获取失败：${daily.error instanceof Error ? daily.error.message : '未知错误'}`}
          <button type="button" className="pill" style={{ marginLeft: 'auto' }} onClick={() => void daily.refetch()}>
            <RefreshCw />
            重试
          </button>
        </div>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>完整歌单</h2>
          <span className="sub">{songs.length} 首 · {formatTotalDuration(totalDuration)}</span>
        </div>
        {daily.isLoading ? (
          <TracksSkeleton />
        ) : (
          <TrackTable
            songs={songs}
            playingMid={playingMid}
            playing={playing}
            onPlay={(index) => void playQueue(songs, index, '每日 30 首')}
            likedMids={likedMids}
            onToggleLike={(song) => void toggleLike(song)}
          />
        )}
      </section>
    </div>
  );
}
