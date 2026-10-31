import type { CloseAction, Quality, ShellSettings } from '@qmusic/shared-types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { bridge, IS_TAURI, type ShellPrefsPatch } from '@/bridge';
import { toast } from '@/shared/ui/ui-store';

export type Theme = 'dark' | 'light';

export const MB = 1024 * 1024;

interface SettingsState {
  theme: Theme;
  quality: Quality;
  sidebarCollapsed: boolean;
  gridDensity: 'comfortable' | 'compact';

  /** 以下字段的真源在 Rust（prefs.json）：关闭窗口时后端就要知道，等不到前端启动 */
  closeAction: CloseAction;
  minimizeToTray: boolean;
  streamCache: boolean;
  cacheDir: string;
  defaultCacheDir: string;
  cacheMaxBytes: number;
  cacheUsedBytes: number;
  cacheFileCount: number;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setQuality: (quality: Quality) => void;
  toggleSidebar: () => void;
  /** 启动时从平台层取回偏好与占用 */
  hydrateShell: (value: ShellSettings) => void;
  updatePrefs: (patch: ShellPrefsPatch) => Promise<void>;
  refreshCacheStats: () => Promise<void>;
  clearStreamCache: () => Promise<void>;
}

function shellFields(value: ShellSettings): Partial<SettingsState> {
  return {
    closeAction: value.closeAction,
    minimizeToTray: value.minimizeToTray,
    streamCache: value.streamCache,
    cacheDir: value.cacheDir,
    defaultCacheDir: value.defaultCacheDir,
    cacheMaxBytes: value.cacheMaxBytes,
    cacheUsedBytes: value.cacheUsedBytes,
    cacheFileCount: value.cacheFileCount,
  };
}

/** 本地偏好：主题 / 音质 / 侧栏折叠走 localStorage；窗口与缓存偏好走平台层。 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'light',
      quality: '320',
      sidebarCollapsed: false,
      gridDensity: 'comfortable',

      closeAction: 'tray',
      minimizeToTray: true,
      streamCache: true,
      cacheDir: '',
      defaultCacheDir: '',
      cacheMaxBytes: 1024 * MB,
      cacheUsedBytes: 0,
      cacheFileCount: 0,

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setQuality: (quality) => set({ quality }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      hydrateShell: (value) => set(shellFields(value)),

      updatePrefs: async (patch) => {
        // 先乐观更新，失败时由平台层返回值或错误提示纠正
        set(patch as Partial<SettingsState>);
        if (!IS_TAURI) return;
        try {
          set(shellFields(await bridge.settings.update(patch)));
        } catch (error) {
          toast(error instanceof Error ? error.message : '设置保存失败', 'error');
          // 平台层拒绝了这次修改（例如目录不可写），把界面拉回真实值
          void bridge.settings
            .get()
            .then((value) => set(shellFields(value)))
            .catch(() => undefined);
        }
      },

      refreshCacheStats: async () => {
        if (!IS_TAURI) return;
        try {
          const stats = await bridge.cache.stats();
          set({
            cacheDir: stats.dir,
            defaultCacheDir: stats.defaultDir,
            cacheUsedBytes: stats.usedBytes,
            cacheFileCount: stats.fileCount,
          });
        } catch {
          // 统计失败不影响播放
        }
      },

      clearStreamCache: async () => {
        if (!IS_TAURI) return;
        const stats = await bridge.cache.clear();
        set({
          cacheDir: stats.dir,
          defaultCacheDir: stats.defaultDir,
          cacheUsedBytes: stats.usedBytes,
          cacheFileCount: stats.fileCount,
        });
      },
    }),
    {
      name: 'qmusic:settings',
      version: 2,
      // 平台侧偏好不写 localStorage，避免两份真源打架
      partialize: (state) => ({
        theme: state.theme,
        quality: state.quality,
        sidebarCollapsed: state.sidebarCollapsed,
        gridDensity: state.gridDensity,
      }),
      // 换了视觉系统：老用户的暗色偏好一次性回到花期白天
      migrate: (state) => ({ ...(state as object), theme: 'light' }) as SettingsState,
    },
  ),
);

export const QUALITY_OPTIONS: { value: Quality; label: string; hint: string }[] = [
  { value: 'flac', label: '无损 FLAC', hint: '最高音质，文件较大' },
  { value: '320', label: 'HQ 320k', hint: '推荐，体积与音质平衡' },
  { value: '128', label: '标准 128k', hint: '省流量' },
];

/** 播放缓存上限档位；平台层会把值收敛到 128MB ~ 64GB */
export const CACHE_LIMIT_OPTIONS: { value: number; label: string }[] = [
  { value: 512 * MB, label: '512 MB' },
  { value: 1024 * MB, label: '1 GB' },
  { value: 2 * 1024 * MB, label: '2 GB' },
  { value: 5 * 1024 * MB, label: '5 GB' },
];
