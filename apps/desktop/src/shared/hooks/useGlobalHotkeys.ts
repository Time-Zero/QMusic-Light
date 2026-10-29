import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '@/features/player/player-store';
import { useUiStore } from '@/shared/ui/ui-store';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** 快捷键（文档 §7.6） */
export function useGlobalHotkeys() {
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 行内/滑块已经消费过的事件不再重复处理
      if (event.defaultPrevented) return;

      const ui = useUiStore.getState();
      const player = usePlayerStore.getState();
      const mod = event.ctrlKey || event.metaKey;
      const typing = isTyping(event.target);
      const onSlider =
        event.target instanceof HTMLElement && Boolean(event.target.closest('[role="slider"]'));

      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ui.togglePalette();
        return;
      }
      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        navigate('/search');
        return;
      }
      if (event.key === 'Escape') {
        if (ui.paletteOpen) ui.setPaletteOpen(false);
        else if (player.showNowPlaying) player.setShowNowPlaying(false);
        else if (player.showQueue) player.setShowQueue(false);
        return;
      }
      if (typing) return;

      if (mod && event.key === 'ArrowLeft') {
        event.preventDefault();
        void player.prev();
        return;
      }
      if (mod && event.key === 'ArrowRight') {
        event.preventDefault();
        void player.next();
        return;
      }

      if (event.code === 'Space') {
        event.preventDefault();
        void player.toggle();
        return;
      }
      if (onSlider && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        player.seek(Math.max(0, player.currentTime - 5));
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        player.seek(player.currentTime + 5);
        return;
      }
      if (event.key.toLowerCase() === 'm') {
        player.toggleMute();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);
}
