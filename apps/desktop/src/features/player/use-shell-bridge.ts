import { listen } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { bridge, IS_TAURI } from '@/bridge';
import { useCurrentSong, usePlayerStore } from './player-store';

type ShellAction = 'toggle' | 'next' | 'prev' | 'show';

/**
 * 托盘菜单 → 播放动作。窗口收起后渲染层仍在跑，所以控制指令走事件而不是原生播放器。
 * 顺便把当前曲目同步到托盘悬浮提示。
 */
export function useShellBridge() {
  const song = useCurrentSong();
  const playing = usePlayerStore((s) => s.playing);

  useEffect(() => {
    if (!IS_TAURI) return;
    let alive = true;
    const pending = listen<{ action?: ShellAction }>('shell:action', (event) => {
      if (!alive) return;
      const player = usePlayerStore.getState();
      switch (event.payload?.action) {
        case 'toggle':
          void player.toggle();
          break;
        case 'next':
          void player.next();
          break;
        case 'prev':
          void player.prev();
          break;
        case 'show':
        default:
          break;
      }
    });
    return () => {
      alive = false;
      void pending.then((off) => off()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!IS_TAURI) return;
    void bridge.settings.traySync({ title: song?.name ?? '', playing }).catch(() => undefined);
  }, [song?.name, playing]);
}
