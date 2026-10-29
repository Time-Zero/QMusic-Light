import { IS_TAURI } from '@/bridge';
import { WindowControls } from '@/shared/components/WindowControls';

export function BootSplash({ error }: { error?: string }) {
  return (
    <div className="boot-splash" data-tauri-drag-region={IS_TAURI ? true : undefined}>
      <div className="chrome-corner">
        <WindowControls />
      </div>
      <div className="boot-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M9 18.5a3.5 3.5 0 1 1-2-3.16V6l11-2v9.5a3.5 3.5 0 1 1-2-3.16V6.6L9 8.1v10.4Z" />
        </svg>
      </div>
      <div className="boot-title">QQ 音乐 · Lite</div>
      {error ? (
        <p className="boot-error">{error}</p>
      ) : (
        <div className="boot-loading">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
