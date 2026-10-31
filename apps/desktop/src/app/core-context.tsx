import { createCore, PersistentCache, type Core } from '@core';
import type { SysInfo } from '@qmusic/shared-types';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { bridge } from '@/bridge';
import { useSessionStore } from '@/features/auth/session-store';
import { bindPlayer } from '@/features/player/player-store';
import { deviceGuid } from '@/shared/lib/device';
import { BootSplash } from '@/shared/ui/BootSplash';
import { toast } from '@/shared/ui/ui-store';
import { useSettingsStore } from './settings-store';

interface CoreContextValue {
  core: Core;
  sys?: SysInfo;
}

const CoreContext = createContext<CoreContextValue | null>(null);

export function CoreProvider({ children }: { children: ReactNode }) {
  const [core, setCore] = useState<Core | null>(null);
  const [sys, setSys] = useState<SysInfo | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const cache = new PersistentCache(bridge.db);
        await cache.hydrate();

        const instance = createCore({
          transport: bridge.api,
          cache,
          db: bridge.db,
          getAccount: () => useSessionStore.getState().account,
          getGuid: deviceGuid,
          getQuality: () => useSettingsStore.getState().quality,
        });
        if (!alive) return;

        bindPlayer(instance);
        setCore(instance);

        void bridge.sys
          .info()
          .then((info) => alive && setSys(info))
          .catch(() => undefined);

        // 窗口/托盘/缓存偏好的真源在平台层，启动时回灌到设置 store
        void bridge.settings
          .get()
          .then((value) => {
            if (alive) useSettingsStore.getState().hydrateShell(value);
          })
          .catch(() => undefined);

        const restored = await bridge.auth.restore();
        if (!alive) return;

        if (restored.account) {
          useSessionStore.getState().setAccount(restored.account);
        } else if (restored.expired) {
          useSessionStore.getState().setExpired(true);
          toast('登录态已过期，请重新扫码登录', 'error');
        } else {
          useSessionStore.getState().setStatus('guest');
        }
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : '初始化失败');
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return <BootSplash error={`启动失败：${error}`} />;
  }
  if (!core) {
    return <BootSplash />;
  }

  return <CoreContext.Provider value={{ core, sys }}>{children}</CoreContext.Provider>;
}

export function useCore(): Core {
  const value = useContext(CoreContext);
  if (!value) throw new Error('useCore 必须在 CoreProvider 内使用');
  return value.core;
}

export function useSysInfo(): SysInfo | undefined {
  return useContext(CoreContext)?.sys;
}
