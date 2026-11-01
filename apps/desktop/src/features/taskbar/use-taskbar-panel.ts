import { useEffect } from 'react';
import { useSettingsStore } from '@/app/settings-store';
import { bridge, IS_TAURI } from '@/bridge';
import { useCurrentSong, usePlayerStore } from '@/features/player/player-store';
import { coverAtSize } from '@/shared/lib/color';
import { singerNames } from '@/shared/lib/format';

/**
 * 主窗口侧的任务栏面板同步。
 *
 * 面板只是个显示器，拿不到播放器，所以这里只做一件事：换歌 / 播放暂停时推一次快照。
 * 频率天然很低（一次换歌一次），不像桌面歌词那样还要跟着进度逐行推。
 *
 * 推的是「完整的一帧」而不是补丁：平台侧合并后广播，面板先起来还是主窗口先起来都对得上。
 * 没有在播的曲目时推 `song: null`，平台侧据此把窗口整个收起来 ——
 * 一个空的面板留在任务栏上只会挡住托盘的点击。
 */
export function useTaskbarPanel() {
  const song = useCurrentSong();
  const playing = usePlayerStore((s) => s.playing);
  const enabled = useSettingsStore((s) => s.taskbarPanel);

  useEffect(() => {
    if (!IS_TAURI || !enabled) return;
    void bridge.taskbar
      .sync({
        song: song
          ? {
              name: song.name,
              singers: singerNames(song.singers),
              // 面板上的封面只有二十来像素：按 150 取图，别为了一枚圆点解码 300×300。
              // 注意尺寸模板只认少数几档（90/150/300/500…），96 会直接 404
              cover: song.cover ? coverAtSize(song.cover, 150) : null,
            }
          : null,
        playing,
      })
      .catch(() => undefined);
  }, [enabled, song, playing]);
}
