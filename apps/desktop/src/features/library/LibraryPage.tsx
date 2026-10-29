import { useQuery } from '@tanstack/react-query';
import { TTL } from '@core';
import { Heart, LibraryBig, LogIn, Play, Plus, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useAccount } from '@/features/auth/session-store';
import { usePlayerStore } from '@/features/player/player-store';
import { cn } from '@/shared/lib/cn';
import { formatTotalDuration } from '@/shared/lib/format';
import { CoverCard } from '@/shared/ui/CoverCard';
import { EmptyState } from '@/shared/ui/EmptyState';
import { CardGridSkeleton, TracksSkeleton } from '@/shared/ui/Skeleton';
import { TrackTable } from '@/shared/ui/TrackTable';
import { toast, useUiStore } from '@/shared/ui/ui-store';
import { useLikeActions } from './use-like';

type Tab = 'created' | 'collected' | 'liked';

export default function LibraryPage() {
  const core = useCore();
  const navigate = useNavigate();
  const account = useAccount();
  const setCrumb = useUiStore((s) => s.setCrumb);
  const [params, setParams] = useSearchParams();
  const rawTab = params.get('tab');
  const tab: Tab = rawTab === 'collected' || rawTab === 'liked' ? rawTab : 'created';

  const playQueue = usePlayerStore((s) => s.playQueue);
  const playingMid = usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index]?.mid : undefined));
  const playing = usePlayerStore((s) => s.playing);
  const { likedMids, toggleLike } = useLikeActions();

  useEffect(() => setCrumb('我的音乐'), [setCrumb]);

  const mine = useQuery({
    queryKey: ['mine', account?.uin],
    queryFn: () => core.playlists.mine(account!),
    enabled: Boolean(account),
    staleTime: TTL.myPlaylists,
    retry: 0,
  });

  const collected = useQuery({
    queryKey: ['collected', account?.uin],
    queryFn: () => core.playlists.collected(account!),
    enabled: Boolean(account),
    staleTime: TTL.myPlaylists,
    retry: 0,
  });

  const liked = useQuery({
    queryKey: ['liked', account?.uin],
    queryFn: () => core.playlists.liked(account!, 0, 500),
    enabled: Boolean(account) && tab === 'liked',
    staleTime: TTL.playlistDetail,
    retry: 0,
  });

  if (!account) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">我的音乐</h1>
            <p className="page-sub">我喜欢、自建歌单与收藏歌单，只在本机展示</p>
          </div>
        </div>
        <EmptyState
          icon={<LibraryBig />}
          title="登录后同步你的音乐"
          description="扫码登录后可读取自建歌单、收藏歌单与红心歌曲。凭证只保存在本机。"
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

  const setTab = (next: Tab) => {
    setParams(next === 'created' ? {} : { tab: next }, { replace: true });
  };

  const currentList = tab === 'collected' ? collected.data : mine.data;
  const isLoading = tab === 'collected' ? collected.isLoading : mine.isLoading;
  const likedSongs = liked.data?.songs ?? [];

  return (
    <div>
      <div className="library-head">
        <h1>我的音乐</h1>
        <div className="tabs" role="tablist">
          <button
            type="button"
            className={cn('tab', tab === 'created' && 'active')}
            onClick={() => setTab('created')}
          >
            自建歌单
          </button>
          <button
            type="button"
            className={cn('tab', tab === 'collected' && 'active')}
            onClick={() => setTab('collected')}
          >
            收藏的歌单
          </button>
          <button
            type="button"
            className={cn('tab', tab === 'liked' && 'active')}
            onClick={() => setTab('liked')}
          >
            我喜欢的音乐
          </button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void mine.refetch();
              void collected.refetch();
              if (tab === 'liked') void liked.refetch();
            }}
          >
            <RefreshCw />
            刷新
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => toast('新建歌单属于 P2 写接口，当前版本暂未开放')}
          >
            <Plus />
            新建歌单
          </button>
        </div>
      </div>

      {tab === 'liked' ? (
        <>
          <section className="liked-banner">
            <div className="heart">
              <Heart fill="currentColor" />
            </div>
            <div className="lb-body">
              <h2>我喜欢的音乐</h2>
              <p>
                {liked.isLoading
                  ? '正在读取…'
                  : `${likedSongs.length} 首 · ${formatTotalDuration(
                      likedSongs.reduce((sum, song) => sum + song.duration, 0),
                    )}`}
              </p>
            </div>
            <div className="lb-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={likedSongs.length === 0}
                onClick={() => void playQueue(likedSongs, 0, '我喜欢的音乐')}
              >
                <Play />
                播放全部
              </button>
            </div>
          </section>

          {liked.isLoading ? (
            <TracksSkeleton count={10} />
          ) : liked.isError ? (
            <EmptyState
              icon={<Heart />}
              title="读取我喜欢的音乐失败"
              description={liked.error instanceof Error ? liked.error.message : '请稍后重试'}
              action={
                <button type="button" className="btn btn-ghost" onClick={() => void liked.refetch()}>
                  重试
                </button>
              }
            />
          ) : likedSongs.length === 0 ? (
            <EmptyState
              icon={<Heart />}
              title="还没有红心歌曲"
              description="在播放条或歌曲列表点红心，就会出现在这里。"
            />
          ) : (
            <TrackTable
              songs={likedSongs}
              playingMid={playingMid}
              playing={playing}
              onPlay={(index) => void playQueue(likedSongs, index, '我喜欢的音乐')}
              likedMids={likedMids}
              onToggleLike={(song) => void toggleLike(song)}
            />
          )}
        </>
      ) : isLoading ? (
        <CardGridSkeleton />
      ) : currentList && currentList.length > 0 ? (
        <div className="cards cards-6">
          {currentList.map((playlist) => (
            <CoverCard
              key={`${tab}-${playlist.id}`}
              title={playlist.title}
              subtitle={`${playlist.songCount} 首`}
              cover={playlist.cover}
              seed={playlist.id}
              onOpen={() => navigate(`/playlist/${playlist.id}?kind=${tab === 'collected' ? 'collected' : 'created'}`)}
              onPlay={() => navigate(`/playlist/${playlist.id}?kind=${tab === 'collected' ? 'collected' : 'created'}`)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<LibraryBig />}
          title={tab === 'created' ? '还没有自建歌单' : '还没有收藏歌单'}
          description={
            tab === 'created'
              ? '在手机 QQ 音乐里创建歌单后，这里会自动同步。'
              : '收藏别人的歌单后，这里会显示。'
          }
        />
      )}
    </div>
  );
}
