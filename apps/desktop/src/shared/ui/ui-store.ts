import { create } from 'zustand';
import { OVERLAY_EXIT, prefersReducedMotion } from '@/shared/lib/motion';

export type ToastType = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  /** 正在退场：已不再交互，等待退场动画结束后从列表移除 */
  leaving?: boolean;
}

interface UiState {
  toasts: Toast[];
  paletteOpen: boolean;
  crumb: string;
  toast: (message: string, type?: ToastType) => void;
  dismiss: (id: number) => void;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setCrumb: (crumb: string) => void;
}

let nextId = 1;

export const useUiStore = create<UiState>()((set, get) => ({
  toasts: [],
  paletteOpen: false,
  crumb: '',
  toast: (message, type = 'info') => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts.slice(-2), { id, message, type }] }));
    window.setTimeout(() => get().dismiss(id), 3000);
  },
  dismiss: (id) => {
    const target = get().toasts.find((t) => t.id === id);
    if (!target || target.leaving) return;

    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)),
    }));
    window.setTimeout(
      () => {
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      },
      prefersReducedMotion() ? 0 : OVERLAY_EXIT,
    );
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set((state) => ({ paletteOpen: !state.paletteOpen })),
  setCrumb: (crumb) => set({ crumb }),
}));

export const toast = (message: string, type: ToastType = 'info') => useUiStore.getState().toast(message, type);
