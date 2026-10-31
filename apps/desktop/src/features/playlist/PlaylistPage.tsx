import { useInfiniteQuery } from '@tanstack/react-query';
import { TTL } from '@core';
import type { Playlist, Song } from '@qmusic/shared-types';
import { Heart, ListPlus, LogIn, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useAccount } from '@/features/auth/session-store';
import { useLikeActions } from '@/features/library/use-like';
import { usePlayerStore } from '@/features/player/player-store';
import { coverVars } from '@/shared/lib/color';
import { formatCount, formatTotalDuration } from '@/shared/lib/format';
import { CoverImage } from '@/shared/ui/CoverImage';
import { EmptyState } from '@/shared/ui/EmptyState';
import { TracksSkeleton } from '@/shared/ui/Skeleton';
import { TrackTable } from '@/shared/ui/TrackTable';
import { useUiStore } from '@/shared/ui/ui-store';

const KIND_LABEL: Record<string, string> = {
  created: '自建歌单',
  collected: '收藏的歌单',
  liked: '我喜欢的音乐',
  daily: '每日推荐',
  public: '公开歌单',
};

export default function PlaylistPage() {
  const core = useCore();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const account = useAccount();
  const setCrumb = useUiStore((s) => s.setCrumb);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const appendQueue = usePlayerStore((s) => s.appendQueue);
  const playingMid = usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index]?.mid : undefined));
  const playing = usePlayerStore((s) => s.playing);

  const idParam = params.id ?? '0';
  const isLiked = idParam === '0';
  const kind = (searchParams.get('kind') ?? (isLiked ? 'liked' : 'public')) as Playlist['kind'];
  const playlistId = Number(idParam);

  const [cached, setCached] = useState<{ playlist: Playlist; songs: Song[] } | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['playlist', idParam, kind, account?.uin ?? 'guest'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      isLiked
        ? core.playlists.liked(account!, pageParam, 500)
        : core.playlists.detail(playlistId, {
            kind,
            begin: pageParam,
            num: 500,
            account,
          }),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.songs.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    enabled: Boolean(idParam) && (!isLiked || Boolean(account)),
    staleTime: TTL.playlistDetail,
    retry: 0,
  });

  const playlist = query.data?.pages[0]?.playlist ?? cached?.playlist;
  const songs = useMemo(
    () => query.data?.pages.flatMap((page) => page.songs) ?? cached?.songs ?? [],
    [query.data, cached],
  );
  const total = query.data?.pages[0]?.total ?? songs.length;
  const { likedMids, toggleLike } = useLikeActions(songs, { allLiked: isLiked });

  useEffect(() => {
    const prefix = isLiked || kind === 'created' || kind === 'collected' ? '我的音乐' : '发现';
    setCrumb(playlist ? `${prefix} / ${playlist.title}` : '歌单详情');
    document.title = playlist ? `${playlist.title} · QQ 音乐 Lite` : 'QQ 音乐 · Lite';
  }, [playlist, setCrumb, isLiked, kind]);

  useEffect(() => {
    if (!query.isError) {
      setCached(null);
      return;
    }
    let alive = true;
    void core.repo
      .loadPlaylist(playlistId, account?.uin ?? '')
      .then((value) => alive && setCached(value))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [query.isError, core, playlistId, account?.uin]);

  useEffect(() => {
    const first = query.data?.pages[0];
    if (!first || !playlist) return;
    if (songs.length >= first.total && songs.length > 0) {
      void core.repo.savePlaylist(playlist, songs, account?.uin ?? '').catch(() => undefined);
    }
  }, [query.data, playlist, songs, core, account?.uin]);

  if (isLiked && !account) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">我喜欢的音乐</h1>
            <p className="page-sub">红心歌曲保存在你的 QQ 音乐账号里</p>
          </div>
        </div>
        <EmptyState
          icon={<Heart />}
          title="登录后查看我喜欢的音乐"
          description="「我喜欢」对应 dirId=201，需要登录态才能读写。"
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

  if (query.isError && !cached) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">歌单加载失败</h1>
            <p className="page-sub">
              {query.error instanceof Error ? query.error.message : '接口暂时不可用'}
            </p>
          </div>
        </div>
        <EmptyState
          icon={<TriangleAlert />}
          title="无法获取歌单"
          description="可能是网络问题，或接口字段发生变化。可以重试，或先浏览推荐内容。"
          action={
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={() => void query.refetch()}>
                <RefreshCw />
                重试
              </button>
              <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
                回到发现
              </button>
            </div>
          }
        />
      </div>
    );
  }

  const totalDuration = songs.reduce((sum, song) => sum + song.duration, 0);
  const kindLabel = KIND_LABEL[kind] ?? '歌单';

  return (
    <div className="playlist-page">
      <section className="hero" style={coverVars(playlist?.id ?? idParam)}>
        <div className="hero-cover">
          {playlist?.cover ? (
            <CoverImage src={playlist.cover} alt={playlist.title} />
          ) : (
            <span className="glyph">{isLiked ? '♥' : '♫'}</span>
          )}
        </div>
        <div className="hero-body">
          <div className="hero-kicker">
            <span className="live" />
            {kindLabel.toUpperCase()}
          </div>
          <h1>{playlist?.title || (isLiked ? '我喜欢的音乐' : '歌单')}</h1>
          <div className="hero-meta">
            {playlist?.creator ? (
              <>
                <span>{playlist.creator}</span>
                <i />
              </>
            ) : null}
            <span>{total || songs.length} 首</span>
            {songs.length > 0 ? (
              <>
                <i />
                <span>{formatTotalDuration(totalDuration)}</span>
              </>
            ) : null}
            {playlist?.playCount ? (
              <>
                <i />
                <span>{formatCount(playlist.playCount)} 播放</span>
              </>
            ) : null}
          </div>
          {playlist?.description ? <p className="hero-desc">{playlist.description}</p> : null}
          <div className="hero-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={songs.length === 0}
              onClick={() => void playQueue(songs, 0, playlist?.title ?? '歌单')}
            >
              <Play />
              播放全部
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={songs.length === 0}
              onClick={() => appendQueue(songs)}
            >
              <ListPlus />
              加入队列
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void query.refetch()}>
              <RefreshCw />
              刷新
            </button>
          </div>
        </div>
        <div className="hero-aside">
          <div className="lab">{isLiked ? '我的收藏' : '歌单信息'}</div>
          <div className="chips">
            {(playlist?.tags ?? [kindLabel]).slice(0, 3).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
          <div className="streak">
            <b>{songs.length}</b>首已加载
          </div>
        </div>
      </section>

      {cached && query.isError ? (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <TriangleAlert />
          网络异常，当前展示本地缓存（{cached.songs.length} 首），可能不是最新。
          <button type="button" className="pill" style={{ marginLeft: 'auto' }} onClick={() => void query.refetch()}>
            重试
          </button>
        </div>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>歌曲列表</h2>
          <span className="sub">
            {songs.length} / {total} 首
          </span>
        </div>

        {query.isLoading ? (
          <TracksSkeleton count={10} />
        ) : songs.length === 0 ? (
          <EmptyState
            icon={<Play />}
            title="这个歌单还没有歌曲"
            description={isLiked ? '在播放条或歌曲列表点红心，就会出现在这里。' : '换一个歌单看看吧。'}
          />
        ) : (
          <>
            <TrackTable
              songs={songs}
              playingMid={playingMid}
              playing={playing}
              onPlay={(index) => void playQueue(songs, index, playlist?.title ?? '歌单')}
              likedMids={likedMids}
              onToggleLike={(song) => void toggleLike(song)}
              fill
            />
            {query.hasNextPage ? (
              <div className="track-list-footer">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage ? '加载中…' : `加载更多（还剩 ${total - songs.length} 首）`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
