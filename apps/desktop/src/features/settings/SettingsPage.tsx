import { QUALITY_LABEL } from '@qmusic/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import {
  Database,
  Info,
  LogIn,
  LogOut,
  MonitorCog,
  Palette,
  SlidersHorizontal,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCore, useSysInfo } from '@/app/core-context';
import { QUALITY_OPTIONS, useSettingsStore } from '@/app/settings-store';
import { bridge } from '@/bridge';
import { useAccount, useSessionStore } from '@/features/auth/session-store';
import { usePlayerStore } from '@/features/player/player-store';
import { cn } from '@/shared/lib/cn';
import { formatDateCN, initials } from '@/shared/lib/format';
import { toast, useUiStore } from '@/shared/ui/ui-store';

export default function SettingsPage() {
  const core = useCore();
  const sys = useSysInfo();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const account = useAccount();
  const expired = useSessionStore((s) => s.expired);
  const setCrumb = useUiStore((s) => s.setCrumb);

  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const quality = useSettingsStore((s) => s.quality);
  const setQuality = useSettingsStore((s) => s.setQuality);
  const collapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);

  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setCrumb('设置');
    document.title = '设置 · QQ 音乐 Lite';
  }, [setCrumb]);

  const logout = async () => {
    setBusy('logout');
    try {
      await bridge.auth.logout();
      useSessionStore.getState().reset();
      usePlayerStore.getState().clearQueue();
      queryClient.clear();
      toast('已退出登录，本地凭证已清除', 'success');
      navigate('/login');
    } catch (error) {
      toast(error instanceof Error ? error.message : '退出失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const clearCache = async () => {
    setBusy('cache');
    try {
      core.cache.clear();
      await queryClient.invalidateQueries();
      toast('接口缓存已清除', 'success');
    } finally {
      setBusy(null);
    }
  };

  const clearHistory = async () => {
    setBusy('history');
    try {
      await core.repo.clearHistory();
      await queryClient.invalidateQueries({ queryKey: ['recent'] });
      toast('播放记录已清空', 'success');
    } finally {
      setBusy(null);
    }
  };

  const clearAll = async () => {
    setBusy('all');
    try {
      core.cache.clear();
      await core.repo.clearLocalData();
      queryClient.clear();
      toast('本地数据已全部清除', 'success');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-sub">偏好保存在本机；凭证在系统级存储中，不会上传</p>
        </div>
      </div>

      {expired ? (
        <div className="error-banner">
          <TriangleAlert />
          登录态已过期（续期失败），请重新扫码登录。
          <button type="button" className="pill" style={{ marginLeft: 'auto' }} onClick={() => navigate('/login')}>
            重新登录
          </button>
        </div>
      ) : null}

      <div className="settings-grid">
        <section className="setting-card">
          <h3>
            <UserRound />
            账号
          </h3>
          {account ? (
            <>
              <div className="settings-account" style={{ marginTop: 14 }}>
                <span className="avatar">
                  {account.avatar ? <img src={account.avatar} alt="" /> : initials(account.nickname)}
                </span>
                <span>
                  <div className="nick">{account.nickname}</div>
                  <div className="uin">
                    QQ {account.uin}
                    {account.vipLabel ? ` · ${account.vipLabel}` : ''}
                  </div>
                </span>
              </div>
              <div className="setting-row" style={{ marginTop: 12 }}>
                <span className="label">登录有效期</span>
                <span className="value">
                  {account.keyExpiresAt
                    ? `${formatDateCN(new Date(account.keyExpiresAt))} 到期（自动续期）`
                    : '—'}
                </span>
              </div>
              <div className="setting-row">
                <span className="label">账号凭据</span>
                <span className="value">钥匙串 / 本地私有存储，前端不可见</span>
              </div>
              <div className="setting-row">
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy === 'logout'}
                  onClick={() => void logout()}
                >
                  <LogOut />
                  退出登录
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 12, fontSize: 12, lineHeight: 1.8 }}>
                未登录。匿名可浏览公开歌单、推荐与歌词；播放与个人歌单需要扫码。
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                style={{ marginTop: 14 }}
                onClick={() => navigate('/login')}
              >
                <LogIn />
                扫码登录
              </button>
            </>
          )}
        </section>

        <section className="setting-card">
          <h3>
            <Palette />
            外观
          </h3>
          <div className="setting-row" style={{ marginTop: 8 }}>
            <span className="label">主题</span>
            <div className="seg">
              <button
                type="button"
                className={cn(theme === 'dark' && 'active')}
                onClick={() => setTheme('dark')}
              >
                深色
              </button>
              <button
                type="button"
                className={cn(theme === 'light' && 'active')}
                onClick={() => setTheme('light')}
              >
                浅色
              </button>
            </div>
          </div>
          <div className="setting-row">
            <span className="label">侧栏</span>
            <div className="seg">
              <button
                type="button"
                className={cn(!collapsed && 'active')}
                onClick={() => collapsed && toggleSidebar()}
              >
                展开
              </button>
              <button
                type="button"
                className={cn(collapsed && 'active')}
                onClick={() => !collapsed && toggleSidebar()}
              >
                收起
              </button>
            </div>
          </div>
          <div className="setting-row">
            <span className="label">动效</span>
            <span className="value">切歌 ≤180ms；列表使用虚拟滚动</span>
          </div>
        </section>

        <section className="setting-card">
          <h3>
            <SlidersHorizontal />
            播放
          </h3>
          <div className="setting-row" style={{ marginTop: 8 }}>
            <span className="label">首选音质</span>
            <div className="seg">
              {QUALITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={cn(quality === option.value && 'active')}
                  onClick={() => setQuality(option.value)}
                  title={option.hint}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <span className="label">当前策略</span>
            <span className="value">{QUALITY_LABEL[quality]} · purl 为空时自动降级 FLAC → 320 → 128</span>
          </div>
          <div className="setting-row">
            <span className="label">播放后端</span>
            <span className="value">HTML5 Audio + Media Session（可替换 PlayerBackend）</span>
          </div>
        </section>

        <section className="setting-card">
          <h3>
            <Database />
            本地数据
          </h3>
          <div className="setting-row" style={{ marginTop: 8 }}>
            <span className="label">接口缓存</span>
            <button
              type="button"
              className="pill"
              style={{ marginLeft: 'auto' }}
              disabled={busy === 'cache'}
              onClick={() => void clearCache()}
            >
              清除缓存
            </button>
          </div>
          <div className="setting-row">
            <span className="label">播放记录</span>
            <button
              type="button"
              className="pill"
              style={{ marginLeft: 'auto' }}
              disabled={busy === 'history'}
              onClick={() => void clearHistory()}
            >
              清空记录
            </button>
          </div>
          <div className="setting-row">
            <span className="label">全部本地数据</span>
            <button
              type="button"
              className="pill"
              style={{ marginLeft: 'auto' }}
              disabled={busy === 'all'}
              onClick={() => void clearAll()}
            >
              清除全部
            </button>
          </div>
          <p className="muted" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.7 }}>
            清除操作不会登出账号，也不会删除云端歌单。
          </p>
        </section>

        <section className="setting-card">
          <h3>
            <MonitorCog />
            诊断
          </h3>
          <div className="setting-row" style={{ marginTop: 8 }}>
            <span className="label">版本</span>
            <span className="value">{sys?.version ?? '0.1.0'}</span>
          </div>
          <div className="setting-row">
            <span className="label">运行时</span>
            <span className="value">{sys?.webview ?? 'Node 平台层'}</span>
          </div>
          <div className="setting-row">
            <span className="label">平台</span>
            <span className="value">{sys?.platform ?? '—'}</span>
          </div>
          <div className="setting-row">
            <span className="label">命令面</span>
            <span className="value">auth.* / api.call / sys.info / db.*</span>
          </div>
        </section>

        <section className="setting-card">
          <h3>
            <Info />
            关于
          </h3>
          <div className="setting-row" style={{ marginTop: 8 }}>
            <span className="label">项目</span>
            <span className="value">QQ 音乐 · Lite</span>
          </div>
          <div className="setting-row">
            <span className="label">定位</span>
            <span className="value">个人学习与自用，不分发、不上架、不商业化</span>
          </div>
          <div className="settings-disclaimer">
            本项目使用 QQ 音乐 Web CGI 的非官方接口，接口随客户端版本漂移属正常现象。
            不提供付费绕过、下载导出与刷播放量能力：`purl` 为空时只提示「无版权 / 需会员」并降级音质。
            凭证保存在本机，永不写入日志。
          </div>
        </section>
      </div>
    </div>
  );
}
