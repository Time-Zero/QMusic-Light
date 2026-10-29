import type { QrStartResult, QrState } from '@qmusic/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { bridge, IS_TAURI } from '@/bridge';
import { useSessionStore } from '@/features/auth/session-store';
import { WindowControls } from '@/shared/components/WindowControls';
import { cn } from '@/shared/lib/cn';
import { initials } from '@/shared/lib/format';
import { toast } from '@/shared/ui/ui-store';

export default function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const account = useSessionStore((s) => s.account);

  const [qr, setQr] = useState<QrStartResult | null>(null);
  const [state, setState] = useState<QrState>('waiting');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const navigateRef = useRef(navigate);

  navigateRef.current = navigate;

  const start = useCallback(async () => {
    setStarting(true);
    setError('');
    setMessage('');
    setState('waiting');
    setQr(null);
    try {
      const result = await bridge.auth.start('qq');
      setQr(result);
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : '二维码生成失败');
    } finally {
      setStarting(false);
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!qr) return;
    if (state === 'confirmed' || state === 'expired' || state === 'cancelled') return;

    let alive = true;
    const timer = window.setInterval(async () => {
      try {
        const result = await bridge.auth.poll(qr.qrId);
        if (!alive) return;
        setState(result.state);
        if (result.message) setMessage(result.message);

        if (result.state === 'confirmed' && result.account) {
          useSessionStore.getState().setAccount(result.account);
          await queryClient.invalidateQueries();
          toast(`欢迎回来，${result.account.nickname}`, 'success');
          navigateRef.current('/', { replace: true });
        }
      } catch (err) {
        if (!alive) return;
        setState('cancelled');
        setError(err instanceof Error ? err.message : '登录状态查询失败');
      }
    }, 1500);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [qr, state, queryClient]);

  const remaining = qr ? Math.max(0, Math.ceil((qr.expiresAt - now) / 1000)) : 0;
  const overlay =
    state === 'scanned'
      ? { title: '请在手机上确认', text: '已扫描，在 QQ 中点击「登录」即可完成' }
      : state === 'expired'
        ? { title: '二维码已失效', text: '点击下方「刷新二维码」重新获取' }
        : state === 'cancelled'
          ? { title: '登录已取消', text: message || '可以刷新二维码重试' }
          : null;

  if (account) {
    return (
      <div className="login-page" data-tauri-drag-region={IS_TAURI ? true : undefined}>
        <div className="chrome-corner">
          <WindowControls />
        </div>
        <div className="login-card">
          <div className="login-brand">
            <span className="brand-mark">
              <svg viewBox="0 0 24 24">
                <path d="M9 18.5a3.5 3.5 0 1 1-2-3.16V6l11-2v9.5a3.5 3.5 0 1 1-2-3.16V6.6L9 8.1v10.4Z" />
              </svg>
            </span>
            QQ 音乐 · Lite
          </div>
          <h1>已登录</h1>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              justifyContent: 'center',
              marginTop: 18,
            }}
          >
            <span className="avatar" style={{ width: 42, height: 42 }}>
              {account.avatar ? <img src={account.avatar} alt="" /> : initials(account.nickname)}
            </span>
            <span style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 650 }}>{account.nickname}</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                QQ {account.uin}
              </div>
            </span>
          </div>
          <div className="login-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
              进入应用
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => navigate('/settings')}>
              账号设置
            </button>
          </div>
          <p className="login-foot">凭证只保存在本机，不会上传到任何服务器。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page" data-tauri-drag-region={IS_TAURI ? true : undefined}>
      <div className="chrome-corner">
        <WindowControls />
      </div>
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">
            <svg viewBox="0 0 24 24">
              <path d="M9 18.5a3.5 3.5 0 1 1-2-3.16V6l11-2v9.5a3.5 3.5 0 1 1-2-3.16V6.6L9 8.1v10.4Z" />
            </svg>
          </span>
          QQ 音乐 · Lite
        </div>

        <h1>扫码登录</h1>
        <p className="hint">
          打开手机 QQ 扫一扫
          <br />
          {state === 'waiting' && qr ? `二维码 ${remaining} 秒内有效` : '二维码 2 分钟内有效'}
        </p>

        <div className="qr-frame">
          {qr ? (
            <img src={qr.imageDataUrl} alt="QQ 登录二维码" />
          ) : (
            <div className="qr-placeholder">
              {starting ? <Loader2 className="spin" /> : <QrCode size={42} />}
            </div>
          )}
          {overlay ? (
            <div className="qr-overlay">
              <Smartphone size={20} />
              <strong>{overlay.title}</strong>
              <span>{overlay.text}</span>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="error-banner" style={{ textAlign: 'left' }}>
            {error}
          </div>
        ) : null}

        <div className="login-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => toast('微信扫码需要开放平台 appid，属 P1，后续版本开放')}
          >
            微信扫码
          </button>
          <button
            type="button"
            className={cn('btn', 'btn-primary', 'btn-sm')}
            onClick={() => void start()}
            disabled={starting}
          >
            <RefreshCw className={starting ? 'spin' : undefined} />
            刷新二维码
          </button>
        </div>

        <button type="button" className="login-guest" onClick={() => navigate('/')}>
          先逛逛，稍后登录
        </button>

        <p className="login-foot">
          登录即表示同意仅在本机使用，凭证不会上传；
          <br />
          本项目为个人学习用途，不绕过任何付费限制。
        </p>
      </div>
    </div>
  );
}
