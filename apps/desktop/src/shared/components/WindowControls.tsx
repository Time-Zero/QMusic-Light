import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/app/settings-store';
import { IS_TAURI } from '@/bridge';
import { toast } from '@/shared/ui/ui-store';

/**
 * 窗口没有系统边框，这三个按钮长在页面里。
 * 浏览器里调试时整组不渲染，避免出现点不动的假按钮。
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      void win.isMaximized().then((value) => {
        if (alive) setMaximized(value);
      });
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, []);

  if (!IS_TAURI) return null;
  const win = getCurrentWindow();

  // 收进托盘由 Rust 侧拦截关闭请求，这里只负责说清楚「窗口没了但音乐还在」
  const close = () => {
    if (useSettingsStore.getState().closeAction === 'tray') {
      toast('已收进系统托盘，播放继续');
    }
    void win.close();
  };

  return (
    <div className="win-controls">
      <button type="button" className="win-btn" title="最小化" onClick={() => void win.minimize()}>
        <Minus />
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? '还原' : '最大化'}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <Copy /> : <Square />}
      </button>
      <button type="button" className="win-btn close" title="关闭" onClick={close}>
        <X />
      </button>
    </div>
  );
}
