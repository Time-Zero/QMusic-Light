import { activeLineIndex, TTL } from '@core';
import { useQuery } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useMemo, useRef } from 'react';
import { useCore } from '@/app/core-context';
import { useSettingsStore } from '@/app/settings-store';
import { bridge, IS_TAURI, type LyricPatch } from '@/bridge';
import { singerNames } from '@/shared/lib/format';
import { subscribeProgress } from '@/shared/lib/progress-driver';
import { toast } from '@/shared/ui/ui-store';
import { useCurrentSong, usePlayerStore } from './player-store';

/** 推送失败不打扰用户：歌词窗口这时候可能压根没开 */
function push(patch: LyricPatch) {
  void bridge.lyric.sync(patch).catch(() => undefined);
}

/**
 * 主窗口侧的桌面歌词同步。
 *
 * 歌词与音频都在这个窗口里，所以「当前第几句」也在这里算：
 * - 换歌 / 歌词到达：整包推一次（歌名、歌词、行号一起，不留中间态）
 * - 换行：进度循环里二分，只有行号变了才发一次 IPC（约每 2~5 秒一次）
 * - 播放 / 暂停：只推状态，歌词停在原处
 *
 * 浮窗自己关掉时 Rust 会广播 `lyric:state`，这里把开关拉回「关」，
 * 两处按钮与窗口状态因此永远一致。
 */
export function useDesktopLyric() {
  const core = useCore();
  const song = useCurrentSong();
  const playing = usePlayerStore((s) => s.playing);
  const enabled = useSettingsStore((s) => s.desktopLyric);

  // 与播放页共用同一个 query key，歌词只拉一次
  const lyric = useQuery({
    queryKey: ['lyric', song?.mid],
    queryFn: () => core.songs.lyric(song!),
    enabled: Boolean(song) && enabled,
    staleTime: TTL.lyric,
    retry: 1,
  });

  // 没有歌词时 data 为 undefined，`?? []` 每次都造新数组会把下面的 effect 拖成每渲染一次
  const lines = useMemo(() => lyric.data?.lines ?? [], [lyric.data]);
  const secondsRef = useRef(0);
  const indexRef = useRef(-1);

  // 换歌 / 歌词到达：整包推，行号按当前播放位置算好一起发
  useEffect(() => {
    if (!IS_TAURI || !enabled) return;
    const index = lines.length > 0 ? activeLineIndex(lines, secondsRef.current) : -1;
    indexRef.current = index;
    push({
      song: song
        ? { name: song.name, singers: singerNames(song.singers), cover: song.cover ?? null }
        : null,
      lines: lines.map((line) => ({
        time: line.time,
        text: line.text,
        trans: line.trans ?? '',
      })),
      index,
    });
  }, [enabled, song, lines]);

  // 播放 / 暂停：浮窗只换状态，不重排歌词
  useEffect(() => {
    if (!IS_TAURI || !enabled) return;
    push({ playing });
  }, [enabled, playing]);

  // 换行：跟随逐帧进度，行号不变就不发 IPC
  useEffect(() => {
    if (!IS_TAURI || !enabled) return;
    return subscribeProgress(({ seconds }) => {
      secondsRef.current = seconds;
      const next = lines.length > 0 ? activeLineIndex(lines, seconds) : -1;
      if (next === indexRef.current) return;
      indexRef.current = next;
      push({ index: next });
    });
  }, [enabled, lines]);

  // 浮窗上的关闭按钮 / Alt+F4：把开关拉回「关」
  useEffect(() => {
    if (!IS_TAURI) return;
    let alive = true;
    const pending = listen<{ enabled?: boolean }>('lyric:state', (event) => {
      if (!alive) return;
      const next = Boolean(event.payload?.enabled);
      const store = useSettingsStore.getState();
      if (store.desktopLyric !== next) store.setDesktopLyric(next);
    });
    return () => {
      alive = false;
      void pending.then((off) => off()).catch(() => undefined);
    };
  }, []);

  // 上次退出时开着：启动后自动恢复浮窗，不用再点一次
  useEffect(() => {
    if (!IS_TAURI) return;
    if (!useSettingsStore.getState().desktopLyric) return;
    void bridge.lyric.setEnabled(true).catch(() => undefined);
  }, []);
}

/**
 * 开关入口。播放栏与播放页共用这一个函数，
 * 先乐观更新按钮，失败再回滚并提示。
 */
export async function toggleDesktopLyric(next: boolean): Promise<void> {
  if (!IS_TAURI) {
    toast('桌面歌词只在桌面端可用');
    return;
  }
  const store = useSettingsStore.getState();
  if (store.desktopLyric === next) return;

  store.setDesktopLyric(next);
  try {
    await bridge.lyric.setEnabled(next);
    toast(
      next ? '桌面歌词已开启：可拖动到任意位置' : '桌面歌词已关闭',
      next ? 'success' : 'info',
    );
  } catch (error) {
    store.setDesktopLyric(!next);
    toast(error instanceof Error ? error.message : '桌面歌词切换失败', 'error');
  }
}
