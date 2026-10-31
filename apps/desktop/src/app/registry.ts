import type { LucideIcon } from 'lucide-react';
import { CalendarDays, Compass, Heart, History, LibraryBig, Settings } from 'lucide-react';
import type { RouteObject } from 'react-router-dom';

export interface NavItem {
  to: string;
  title: string;
  icon: LucideIcon;
  badge?: string;
  order: number;
}

/** 特性注册表：新增页面只改这里 + 一个目录（文档 §5.3） */
export interface FeatureModule {
  id: string;
  nav?: NavItem | NavItem[];
  routes: RouteObject[];
}

const page = (loader: () => Promise<{ default: React.ComponentType }>) => async () => ({
  Component: (await loader()).default,
});

export const features: FeatureModule[] = [
  {
    id: 'home',
    nav: { to: '/', title: '发现', icon: Compass, order: 1 },
    routes: [{ index: true, lazy: page(() => import('@/features/home/HomePage')) }],
  },
  {
    id: 'daily',
    nav: { to: '/daily', title: '每日 30 首', icon: CalendarDays, badge: '30', order: 2 },
    routes: [{ path: 'daily', lazy: page(() => import('@/features/daily/DailyPage')) }],
  },
  {
    id: 'library',
    nav: { to: '/library', title: '我的音乐', icon: LibraryBig, order: 3 },
    routes: [{ path: 'library', lazy: page(() => import('@/features/library/LibraryPage')) }],
  },
  {
    id: 'liked',
    nav: { to: '/playlist/0?liked=1', title: '我喜欢的音乐', icon: Heart, order: 4 },
    routes: [],
  },
  {
    id: 'recent',
    nav: { to: '/recent', title: '最近播放', icon: History, order: 5 },
    routes: [{ path: 'recent', lazy: page(() => import('@/features/library/RecentPage')) }],
  },
  {
    id: 'playlist',
    routes: [{ path: 'playlist/:id', lazy: page(() => import('@/features/playlist/PlaylistPage')) }],
  },
  {
    id: 'search',
    routes: [{ path: 'search', lazy: page(() => import('@/features/search/SearchPage')) }],
  },
  {
    id: 'settings',
    // 侧栏常驻入口：账号行的齿轮只在登录后出现，未登录也必须能进设置
    nav: { to: '/settings', title: '设置', icon: Settings, order: 99 },
    routes: [{ path: 'settings', lazy: page(() => import('@/features/settings/SettingsPage')) }],
  },
  {
    id: 'player',
    routes: [],
  },
];

export const navItems: NavItem[] = features
  .flatMap((feature) => (Array.isArray(feature.nav) ? feature.nav : feature.nav ? [feature.nav] : []))
  .sort((a, b) => a.order - b.order);
