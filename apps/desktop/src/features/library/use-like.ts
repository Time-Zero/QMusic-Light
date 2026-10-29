import type { Song } from '@qmusic/shared-types';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useAccount } from '@/features/auth/session-store';
import { toast } from '@/shared/ui/ui-store';

/** 红心操作：未登录时引导登录；写接口失败只提示，不破坏页面（文档 §9.3） */
export function useLikeActions() {
  const core = useCore();
  const account = useAccount();
  const navigate = useNavigate();
  const [likedMids, setLikedMids] = useState<Set<string>>(() => new Set());

  const toggleLike = useCallback(
    async (song: Song) => {
      if (!account) {
        toast('登录后才能收藏歌曲');
        navigate('/login');
        return;
      }
      const liked = likedMids.has(song.mid);
      try {
        if (liked) await core.playlists.removeLike(account, song);
        else await core.playlists.addLike(account, song);

        setLikedMids((previous) => {
          const next = new Set(previous);
          if (liked) next.delete(song.mid);
          else next.add(song.mid);
          return next;
        });
        void core.repo.setLiked(song.mid, !liked);
        toast(liked ? '已取消喜欢' : '已加入我喜欢的音乐', 'success');
      } catch (error) {
        toast(error instanceof Error ? error.message : '操作失败', 'error');
      }
    },
    [account, core, likedMids, navigate],
  );

  return { likedMids, toggleLike };
}
