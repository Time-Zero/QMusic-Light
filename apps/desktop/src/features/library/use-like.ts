import { useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type { Song } from '@qmusic/shared-types';
import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useAccount } from '@/features/auth/session-store';
import { toast } from '@/shared/ui/ui-store';
import { useLikedStore } from './liked-store';

interface LikedListData {
  songs: Song[];
  total: number;
}

/** 把一次收藏变更同步进「我喜欢」列表缓存：加进来放最前，取消则直接移除 */
function syncLikedList(client: QueryClient, song: Song, liked: boolean) {
  const apply = <T extends LikedListData>(page: T): T => {
    const exists = page.songs.some((item) => item.mid === song.mid);
    if (liked === exists) return page;
    return {
      ...page,
      songs: liked
        ? [song, ...page.songs]
        : page.songs.filter((item) => item.mid !== song.mid),
      total: Math.max(0, page.total + (liked ? 1 : -1)),
    };
  };

  client.setQueriesData<LikedListData>({ queryKey: ['liked'] }, (page) =>
    page ? apply(page) : page,
  );
  client.setQueriesData<InfiniteData<LikedListData>>({ queryKey: ['playlist', '0'] }, (data) =>
    data ? { ...data, pages: data.pages.map(apply) } : data,
  );
}

interface LikeOptions {
  /**
   * 当前列表本身就是「我喜欢」：里面的歌按定义全部已喜欢。
   * 这种情况不依赖本地缓存，避免服务端已收藏却显示空心。
   */
  allLiked?: boolean;
}

/** 红心操作：未登录时引导登录；写接口失败只提示，不破坏页面（文档 §9.3） */
export function useLikeActions(songs: readonly Song[] = [], options: LikeOptions = {}) {
  const core = useCore();
  const account = useAccount();
  const navigate = useNavigate();
  const client = useQueryClient();
  const allLiked = options.allLiked ?? false;

  const likedMids = useLikedStore((s) => s.likedMids);
  const hydrated = useLikedStore((s) => s.hydrated);
  const setLiked = useLikedStore((s) => s.setLiked);
  const markLiked = useLikedStore((s) => s.markLiked);
  const hydrate = useLikedStore((s) => s.hydrate);

  // 本地缓存里的红心一次性回填，全应用共用（离线也能显示）
  useEffect(() => {
    if (hydrated) return;
    let alive = true;
    void core.repo
      .likedMids()
      .then((mids) => alive && hydrate(mids))
      .catch(() => alive && hydrate([]));
    return () => {
      alive = false;
    };
  }, [core, hydrated, hydrate]);

  // 「我喜欢」列表是权威答案，加载到哪首就标哪首（换账号重置后再补一次）
  useEffect(() => {
    if (!allLiked || songs.length === 0) return;
    markLiked(songs.map((song) => song.mid));
  }, [allLiked, songs, markLiked, hydrated]);

  // 首帧就把「我喜欢」里的歌算成已喜欢，不依赖 effect 落地后才变红
  const visibleLiked = useMemo(() => {
    if (!allLiked || songs.length === 0) return likedMids;
    const next = new Set(likedMids);
    for (const song of songs) next.add(song.mid);
    return next;
  }, [allLiked, songs, likedMids]);

  const toggleLike = useCallback(
    async (song: Song) => {
      if (!account) {
        toast('登录后才能收藏歌曲');
        navigate('/login');
        return;
      }
      const liked = visibleLiked.has(song.mid);
      try {
        if (liked) await core.playlists.removeLike(account, song);
        else await core.playlists.addLike(account, song);

        setLiked(song.mid, !liked);
        void core.repo.setLiked(song.mid, !liked);
        syncLikedList(client, song, !liked);
        toast(liked ? '已取消喜欢' : '已加入我喜欢的音乐', 'success');
      } catch (error) {
        toast(error instanceof Error ? error.message : '操作失败', 'error');
      }
    },
    [account, client, core, navigate, setLiked, visibleLiked],
  );

  return { likedMids: visibleLiked, toggleLike };
}
