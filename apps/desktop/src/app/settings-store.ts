import type { Quality } from '@qmusic/shared-types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface SettingsState {
  theme: Theme;
  quality: Quality;
  sidebarCollapsed: boolean;
  gridDensity: 'comfortable' | 'compact';
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setQuality: (quality: Quality) => void;
  toggleSidebar: () => void;
}

/** 本地偏好：主题 / 音质 / 侧栏折叠。内容数据走 SQLite，偏好走轻量持久化。 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      quality: '320',
      sidebarCollapsed: false,
      gridDensity: 'comfortable',
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      setQuality: (quality) => set({ quality }),
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
    }),
    {
      name: 'qmusic:settings',
      version: 2,
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
