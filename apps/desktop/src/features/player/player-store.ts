import type { Core } from '@core';
import { nextIndex, prevIndex } from '@core';
import type { PlayMode, Quality, Song } from '@qmusic/shared-types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { attachProgressDriver } from '@/shared/lib/progress-driver';
import { toast } from '@/shared/ui/ui-store';
import { localSrc, prefetchTrack, preparePlaybackSrc } from './stream-cache';

let core: Core | null = null;
let audio: HTMLAudioElement | null = null;
let audioBound = false;
let retried = false;
let failures = 0;
/** 播放请求序号：预取会让 playAt 多等一会儿，期间若已切歌就丢弃旧请求 */
let playToken = 0;

const RNG = Math.random;

export interface PlayerState {
  queue: Song[];
  index: number;
  playing: boolean;
  loading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  mode: PlayMode;
  streamQuality?: Quality;
  error?: string;
  showQueue: boolean;
  showNowPlaying: boolean;
  contextLabel: string;

  playQueue: (songs: Song[], start?: number, label?: string) => Promise<void>;
  playAt: (index: number, auto?: boolean) => Promise<void>;
  playSong: (song: Song) => Promise<void>;
  toggle: () => Promise<void>;
  next: (manual?: boolean) => Promise<void>;
  prev: () => Promise<void>;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setMode: (mode: PlayMode) => void;
  cycleMode: () => void;
  setShowQueue: (open: boolean) => void;
  setShowNowPlaying: (open: boolean) => void;
  appendQueue: (songs: Song[]) => void;
  removeAt: (index: number) => void;
  clearQueue: () => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      index: -1,
      playing: false,
      loading: false,
      currentTime: 0,
      duration: 0,
      volume: 0.7,
      muted: false,
      mode: 'list',
      showQueue: false,
      showNowPlaying: false,
      contextLabel: '',

      playQueue: async (songs, start = 0, label = '') => {
        if (songs.length === 0) return;
        const index = Math.min(Math.max(start, 0), songs.length - 1);
        set({ queue: songs, index, contextLabel: label, error: undefined });
        await get().playAt(index);
      },

      playSong: async (song) => {
        const { queue, index } = get();
        const existing = queue.findIndex((s) => s.mid === song.mid);
        if (existing >= 0) {
          await get().playAt(existing);
          return;
        }
        const nextQueue = [...queue];
        if (index < 0) nextQueue.unshift(song);
        else nextQueue.splice(index + 1, 0, song);
        const nextIdx = index < 0 ? 0 : index + 1;
        set({ queue: nextQueue, index: nextIdx, contextLabel: '单曲播放' });
        await get().playAt(nextIdx);
      },

      playAt: async (index, auto = false) => {
        const state = get();
        const song = state.queue[index];
        const instance = core;
        if (!song) return;
        if (!instance) {
          toast('播放服务尚未就绪', 'error');
          return;
        }

        const el = ensureAudio();
        const token = ++playToken;
        set({ index, loading: true, playing: false, currentTime: 0, error: undefined });

        try {
          const info = await instance.stream.resolve(song);
          if (token !== playToken) return;
          // 命中缓存就是本地回放；未命中时抢一段预取窗口，赶不上再回落直链
          const src = await preparePlaybackSrc(song, info);
          if (token !== playToken) return;
          retried = false;
          el.src = src;
          el.currentTime = 0;
          await el.play();
          if (token !== playToken) return;
          set({
            playing: true,
            loading: false,
            duration: song.duration || 0,
            streamQuality: info.quality,
          });
          failures = 0;
          void instance.repo.addHistory(song).catch(() => undefined);
          updateMediaSession(song);
          preloadNext();
        } catch (error) {
          if (token !== playToken) return;
          const message = error instanceof Error ? error.message : '播放失败';
          failures += 1;
          set({ loading: false, playing: false, error: message });
          if (!auto) toast(`无法播放「${song.name}」：${message}`, 'error');

          if (failures >= 3) {
            failures = 0;
            toast('连续 3 首播放失败，已暂停', 'error');
            return;
          }
          if (auto) {
            const target = nextIndex(get().mode, index, get().queue.length, RNG);
            if (target >= 0 && target !== index) {
              window.setTimeout(() => void get().playAt(target, true), 300);
            }
          }
        }
      },

      toggle: async () => {
        const el = ensureAudio();
        if (get().playing) {
          el.pause();
          set({ playing: false });
          return;
        }
        if (el.src) {
          try {
            await el.play();
            return;
          } catch {
            // 直链可能过期，走重新解析
          }
        }
        if (get().queue.length === 0) return;
        await get().playAt(Math.max(get().index, 0));
      },

      next: async (manual = true) => {
        const { queue, index, mode } = get();
        if (queue.length === 0) return;
        const target = nextIndex(mode, index, queue.length, RNG, manual);
        if (target < 0) {
          // 顺序播放走到末尾：自动播完就停住；手动点下一首给个提示，不绕回开头
          if (manual) toast('已到列表末尾');
          else set({ playing: false });
          return;
        }
        await get().playAt(target, !manual);
      },

      prev: async () => {
        const { queue, index, mode, currentTime } = get();
        if (queue.length === 0) return;
        // 播放超过 3 秒时，上一首先回到开头（与主流播放器一致）
        if (currentTime > 3) {
          get().seek(0);
          return;
        }
        const target = prevIndex(mode, index, queue.length, RNG);
        if (target < 0) {
          // 顺序播放的第一首：没有上一首，退回本曲开头
          get().seek(0);
          return;
        }
        await get().playAt(target);
      },

      seek: (time) => {
        const el = ensureAudio();
        const duration = get().duration || el.duration || 0;
        const clamped = Math.min(Math.max(time, 0), duration || time);
        try {
          el.currentTime = clamped;
        } catch {
          // 元数据未加载时忽略
        }
        set({ currentTime: clamped });
      },

      setVolume: (volume) => {
        const el = ensureAudio();
        const clamped = Math.min(Math.max(volume, 0), 1);
        el.volume = clamped;
        el.muted = clamped === 0 ? true : false;
        set({ volume: clamped, muted: clamped === 0 });
      },

      toggleMute: () => {
        const el = ensureAudio();
        const muted = !get().muted;
        el.muted = muted;
        set({ muted });
      },

      setMode: (mode) => set({ mode }),

      cycleMode: () => {
        const order: PlayMode[] = ['list', 'single', 'shuffle', 'order'];
        const next = order[(order.indexOf(get().mode) + 1) % order.length];
        set({ mode: next });
      },

      setShowQueue: (open) => set({ showQueue: open }),
      setShowNowPlaying: (open) => set({ showNowPlaying: open }),

      appendQueue: (songs) => {
        const { queue } = get();
        const seen = new Set(queue.map((song) => song.mid));
        const fresh = songs.filter((song) => !seen.has(song.mid));
        if (fresh.length === 0) {
          toast('队列中已经包含这些歌曲');
          return;
        }
        set({ queue: [...queue, ...fresh] });
        toast(`已加入队列 ${fresh.length} 首`, 'success');
      },

      removeAt: (index) => {
        const { queue, index: current } = get();
        if (index < 0 || index >= queue.length) return;
        const nextQueue = queue.filter((_, i) => i !== index);
        if (nextQueue.length === 0) {
          get().clearQueue();
          return;
        }
        const wasCurrent = index === current;
        const nextIndexValue = index < current ? current - 1 : Math.min(current, nextQueue.length - 1);
        set({ queue: nextQueue, index: nextIndexValue });
        if (wasCurrent) void get().playAt(nextIndexValue);
      },

      clearQueue: () => {
        const el = ensureAudio();
        el.pause();
        el.removeAttribute('src');
        set({ queue: [], index: -1, playing: false, currentTime: 0, duration: 0, contextLabel: '' });
      },
    }),
    {
      name: 'qmusic:player',
      version: 2,
      // v1 的 order 语义是「列表循环」，v2 拆成 order（顺序）与 list（列表循环），
      // 老用户继续按列表循环播放，不改变听感
      migrate: (persisted, version) => {
        const state = persisted as Partial<PlayerState>;
        if (version < 2 && state.mode === 'order') {
          return { ...state, mode: 'list' } as PlayerState;
        }
        return persisted as PlayerState;
      },
      partialize: (state) => ({
        queue: state.queue,
        index: state.index,
        volume: state.volume,
        muted: state.muted,
        mode: state.mode,
        contextLabel: state.contextLabel,
      }),
    },
  ),
);

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    audio.volume = usePlayerStore.getState().volume;
    audio.muted = usePlayerStore.getState().muted;
  }
  if (!audioBound) {
    audioBound = true;
    bindAudioEvents(audio);
  }
  attachProgressDriver(audio);
  return audio;
}

function bindAudioEvents(el: HTMLAudioElement) {
  // 逐帧动画不再读这个状态：进度条与歌词都由 progress-driver 直写 DOM。
  // 这里只维护"整秒"粒度，供时间文本、上一首回退判断等低频消费者使用。
  el.addEventListener('timeupdate', () => {
    const whole = Math.floor(el.currentTime);
    if (whole === Math.floor(usePlayerStore.getState().currentTime)) return;
    usePlayerStore.setState({ currentTime: el.currentTime });
  });

  el.addEventListener('durationchange', () => {
    if (Number.isFinite(el.duration) && el.duration > 0) {
      usePlayerStore.setState({ duration: el.duration });
    }
  });

  el.addEventListener('playing', () => {
    usePlayerStore.setState({ playing: true, loading: false });
  });

  el.addEventListener('pause', () => {
    usePlayerStore.setState({ playing: false });
  });

  el.addEventListener('ended', () => {
    void usePlayerStore.getState().next(false);
  });

  el.addEventListener('error', () => {
    const state = usePlayerStore.getState();
    const song = state.queue[state.index];
    if (!song || !el.src) return;
    if (!retried) {
      // 直链有时效，403 时静默重取一次（文档 §3.5）；若整首已缓存则改读本地
      retried = true;
      void (async () => {
        const quality = state.streamQuality;
        const cached = quality ? await localSrc(song, quality) : null;
        if (cached && cached !== el.src) {
          el.src = cached;
          try {
            await el.play();
            return;
          } catch {
            // 本地也不可用，继续走重新解析
          }
        }
        core?.stream.invalidate(song);
        void state.playAt(state.index, true);
      })();
      return;
    }
    usePlayerStore.setState({ playing: false, loading: false, error: '音频加载失败' });
  });
}

/** 起播后立刻预取下一首，切歌时直接从本地读 */
function preloadNext() {
  const state = usePlayerStore.getState();
  const instance = core;
  if (!instance || state.queue.length < 2) return;
  const target = nextIndex(state.mode, state.index, state.queue.length, RNG);
  if (target < 0 || target === state.index) return;
  const song = state.queue[target];
  if (!song) return;
  void prefetchTrack(instance, song).catch(() => undefined);
}

function updateMediaSession(song: Song) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.name,
      artist: song.singers.map((s) => s.name).join(' / '),
      album: song.albumName,
      artwork: song.cover ? [{ src: song.cover, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => void usePlayerStore.getState().toggle());
    navigator.mediaSession.setActionHandler('pause', () => void usePlayerStore.getState().toggle());
    navigator.mediaSession.setActionHandler('nexttrack', () => void usePlayerStore.getState().next());
    navigator.mediaSession.setActionHandler('previoustrack', () => void usePlayerStore.getState().prev());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') usePlayerStore.getState().seek(details.seekTime);
    });
  } catch {
    // 部分 WebView 不支持 Media Session，忽略
  }
}

export function bindPlayer(instance: Core) {
  core = instance;
  ensureAudio();
}

export const useCurrentSong = () =>
  usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index] : undefined));
