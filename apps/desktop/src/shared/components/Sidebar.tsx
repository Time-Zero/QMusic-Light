import { useQuery } from '@tanstack/react-query';
import { TTL } from '@core';
import { LogIn, Music4, Settings } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { navItems } from '@/app/registry';
import { useCore } from '@/app/core-context';
import { useAccount, useSessionStore } from '@/features/auth/session-store';
import { coverVars } from '@/shared/lib/color';
import { cn } from '@/shared/lib/cn';
import { initials } from '@/shared/lib/format';
import { toast } from '@/shared/ui/ui-store';

export function Sidebar() {
  const core = useCore();
  const account = useAccount();
  const status = useSessionStore((s) => s.status);
  const location = useLocation();
  const navigate = useNavigate();

  const mine = useQuery({
    queryKey: ['mine', account?.uin],
    queryFn: () => core.playlists.mine(account!),
    enabled: Boolean(account),
    staleTime: TTL.myPlaylists,
    retry: 0,
  });

  const collected = useQuery({
    queryKey: ['collected', account?.uin],
    queryFn: () => core.playlists.collected(account!),
    enabled: Boolean(account),
    staleTime: TTL.myPlaylists,
    retry: 0,
  });

  const isActive = (to: string) => {
    const path = to.split('?')[0];
    if (path === '/') return location.pathname === '/';
    return location.pathname === path;
  };

  return (
    <aside className="sidebar">
      <Link to="/" className="brand" aria-label="QQ 音乐 Lite 首页">
        <span className="brand-mark">
          <svg viewBox="0 0 24 24">
            <path d="M9 18.5a3.5 3.5 0 1 1-2-3.16V6l11-2v9.5a3.5 3.5 0 1 1-2-3.16V6.6L9 8.1v10.4Z" />
          </svg>
        </span>
        <span className="brand-text fade-label">
          <span className="brand-name">QQ 音乐</span>
          <span className="brand-sub">Lite · 本地版</span>
        </span>
      </Link>

      <button
        type="button"
        className="search-trigger"
        aria-label="搜索歌曲、歌单"
        onClick={() => navigate('/search')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <span className="fade-label">搜索歌曲、歌单</span>
        <kbd className="fade-label">Ctrl K</kbd>
      </button>

      <nav className="nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn('nav-item', isActive(item.to) && 'active')}
              aria-label={item.title}
            >
              <Icon />
              <span className="fade-label">{item.title}</span>
              {item.badge ? <span className="nav-badge fade-label">{item.badge}</span> : null}
            </Link>
          );
        })}
      </nav>

      {/* fade-label：折叠时整块淡出（不 display:none，否则栏宽动画期间列表会瞬间消失又瞬间长出） */}
      <div className="side-scroll fade-label">
        <div className="side-label">
          我的歌单
          <button
            type="button"
            title="新建歌单"
            onClick={() => toast('新建歌单属于 P2 写接口，当前版本暂未开放')}
          >
            ＋
          </button>
        </div>
        {!account ? (
          <button
            type="button"
            className="pl-item"
            aria-label="登录后同步你的歌单"
            onClick={() => navigate('/login')}
          >
            <i className="dot">
              <Music4 size={12} color="#cfd4dc" />
            </i>
            <span>登录后同步你的歌单</span>
          </button>
        ) : mine.data && mine.data.length > 0 ? (
          mine.data.slice(0, 14).map((playlist) => (
            <Link
              key={playlist.id}
              to={`/playlist/${playlist.id}?kind=created`}
              className={cn(
                'pl-item',
                location.pathname === `/playlist/${playlist.id}` && 'active',
              )}
              style={coverVars(playlist.id)}
              aria-label={playlist.title}
            >
              <i className="dot" />
              <span title={playlist.title}>{playlist.title}</span>
            </Link>
          ))
        ) : (
          <div className="pl-item" aria-disabled="true">
            <i className="dot" />
            <span>{mine.isLoading ? '加载中…' : '暂无自建歌单'}</span>
          </div>
        )}

        <div className="side-label">收藏的歌单</div>
        {collected.data && collected.data.length > 0 ? (
          collected.data.slice(0, 14).map((playlist) => (
            <Link
              key={playlist.id}
              to={`/playlist/${playlist.id}?kind=collected`}
              className={cn(
                'pl-item',
                location.pathname === `/playlist/${playlist.id}` && 'active',
              )}
              style={coverVars(playlist.id)}
              aria-label={playlist.title}
            >
              <i className="dot" />
              <span title={playlist.title}>{playlist.title}</span>
            </Link>
          ))
        ) : (
          <div className="pl-item" aria-disabled="true">
            <i className="dot" />
            <span>{account ? (collected.isLoading ? '加载中…' : '暂无收藏歌单') : '登录后显示'}</span>
          </div>
        )}
      </div>

      <div className="account">
        {status === 'authed' && account ? (
          <>
            <span className="avatar">
              {account.avatar ? <img src={account.avatar} alt="" /> : initials(account.nickname)}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="who ellipsis fade-label">{account.nickname}</span>
              <span className="vip ellipsis fade-label">{account.vipLabel || `QQ ${account.uin}`}</span>
            </span>
            <button
              type="button"
              className="gear fade-label"
              title="设置"
              aria-label="设置"
              onClick={() => navigate('/settings')}
            >
              <Settings size={16} />
            </button>
          </>
        ) : (
          <>
            <span className="avatar">?</span>
            <span style={{ minWidth: 0 }}>
              <span className="who ellipsis fade-label">未登录</span>
              <span className="vip ellipsis fade-label">先逛，再登录</span>
            </span>
            <button
              type="button"
              className="gear fade-label"
              title="扫码登录"
              aria-label="扫码登录"
              onClick={() => navigate('/login')}
            >
              <LogIn size={16} />
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
