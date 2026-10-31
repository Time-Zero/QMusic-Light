import { create } from 'zustand';
import { useSessionStore } from '@/features/auth/session-store';

/**
 * 全应用共享的红心状态。
 * 之前每个页面各拿一份 useState，导致「我喜欢」里的歌默认空心，
 * 列表与播放条之间也互不同步。
 */
interface LikedState {
  likedMids: ReadonlySet<string>;
  /** 本地缓存是否已整体回填过一次 */
  hydrated: boolean;
  setLiked: (mid: string, liked: boolean) => void;
  markLiked: (mids: readonly string[]) => void;
  hydrate: (mids: readonly string[]) => void;
  reset: () => void;
}

const EMPTY: ReadonlySet<string> = new Set();

export const useLikedStore = create<LikedState>()((set) => ({
  likedMids: EMPTY,
  hydrated: false,

  setLiked: (mid, liked) =>
    set((state) => {
      if (!mid || state.likedMids.has(mid) === liked) return state;
      const likedMids = new Set(state.likedMids);
      if (liked) likedMids.add(mid);
      else likedMids.delete(mid);
      return { likedMids };
    }),

  markLiked: (mids) =>
    set((state) => {
      const likedMids = new Set(state.likedMids);
      let changed = false;
      for (const mid of mids) {
        if (!mid || likedMids.has(mid)) continue;
        likedMids.add(mid);
        changed = true;
      }
      return changed ? { likedMids } : state;
    }),

  hydrate: (mids) =>
    set((state) => {
      const likedMids = new Set(state.likedMids);
      for (const mid of mids) if (mid) likedMids.add(mid);
      return { likedMids, hydrated: true };
    }),

  reset: () => set({ likedMids: EMPTY, hydrated: false }),
}));

// 换账号后本地缓存的红心不再可信，整体重置
useSessionStore.subscribe((state, previous) => {
  if (state.account?.uin !== previous.account?.uin) {
    useLikedStore.getState().reset();
  }
});
