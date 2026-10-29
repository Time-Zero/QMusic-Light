import {
  CalendarDays,
  Compass,
  Heart,
  History,
  LibraryBig,
  LogIn,
  Moon,
  Pause,
  Play,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  Volume2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettingsStore } from '@/app/settings-store';
import { useAccount } from '@/features/auth/session-store';
import { usePresence } from '@/shared/hooks/usePresence';
import { cn } from '@/shared/lib/cn';
import { useUiStore } from '@/shared/ui/ui-store';
import { usePlayerStore } from './player-store';

interface Item {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
}

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const navigate = useNavigate();
  const account = useAccount();
  const playing = usePlayerStore((s) => s.playing);
  const muted = usePlayerStore((s) => s.muted);
  const toggleTheme = useSettingsStore((s) => s.toggleTheme);
  const theme = useSettingsStore((s) => s.theme);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const presence = usePresence(open);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      setOpen(false);
      navigate(to);
    };
    const base: Item[] = [
      { id: 'home', label: '发现', hint: '页面', icon: Compass, run: go('/') },
      { id: 'daily', label: '每日 30 首', hint: '页面', icon: CalendarDays, run: go('/daily') },
      { id: 'library', label: '我的音乐', hint: '页面', icon: LibraryBig, run: go('/library') },
      { id: 'liked', label: '我喜欢的音乐', hint: '页面', icon: Heart, run: go('/playlist/0?liked=1') },
      { id: 'recent', label: '最近播放', hint: '页面', icon: History, run: go('/recent') },
      { id: 'search', label: '搜索歌曲 / 歌单', hint: 'Ctrl F', icon: Search, run: go('/search') },
      { id: 'settings', label: '设置', hint: '页面', icon: Settings, run: go('/settings') },
      {
        id: 'play',
        label: playing ? '暂停' : '播放',
        hint: 'Space',
        icon: playing ? Pause : Play,
        run: () => {
          setOpen(false);
          void usePlayerStore.getState().toggle();
        },
      },
      {
        id: 'prev',
        label: '上一首',
        hint: 'Ctrl ←',
        icon: SkipBack,
        run: () => {
          setOpen(false);
          void usePlayerStore.getState().prev();
        },
      },
      {
        id: 'next',
        label: '下一首',
        hint: 'Ctrl →',
        icon: SkipForward,
        run: () => {
          setOpen(false);
          void usePlayerStore.getState().next();
        },
      },
      {
        id: 'mute',
        label: muted ? '取消静音' : '静音',
        hint: 'M',
        icon: Volume2,
        run: () => {
          setOpen(false);
          usePlayerStore.getState().toggleMute();
        },
      },
      {
        id: 'theme',
        label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        hint: '主题',
        icon: Moon,
        run: () => {
          setOpen(false);
          toggleTheme();
        },
      },
    ];

    if (!account) {
      base.push({
        id: 'login',
        label: '扫码登录',
        hint: '账号',
        icon: LogIn,
        run: go('/login'),
      });
    }
    return base;
  }, [account, navigate, muted, playing, setOpen, theme, toggleTheme]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = keyword
      ? items.filter((item) => item.label.toLowerCase().includes(keyword))
      : items;
    if (!keyword) return list;

    const searchItem: Item = {
      id: 'search-query',
      label: `搜索「${query.trim()}」`,
      hint: '回车',
      icon: Search,
      run: () => {
        setOpen(false);
        navigate(`/search?q=${encodeURIComponent(query.trim())}`);
      },
    };
    // 有匹配命令时把「搜索」放最后，避免输入「设置」回车却跳去搜索
    return list.length > 0 ? [...list, searchItem] : [searchItem];
  }, [items, query, navigate, setOpen]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!presence.mounted) return null;

  const runAt = (index: number) => {
    const item = filtered[index];
    if (item) item.run();
  };

  return (
    <div
      className={cn('palette-backdrop', presence.closing && 'is-closing')}
      inert={presence.closing || undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="palette-input">
          <Search />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索页面、操作，或直接搜索歌曲…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, filtered.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => Math.max(value - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runAt(active);
              } else if (event.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          <kbd className="muted" style={{ fontSize: 10 }}>
            Esc
          </kbd>
        </div>
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">没有匹配的命令</div>
          ) : (
            filtered.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn('palette-item', index === active && 'active')}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => item.run()}
                >
                  <Icon />
                  <span className="pi-label">{item.label}</span>
                  <span className="pi-hint">{item.hint}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
