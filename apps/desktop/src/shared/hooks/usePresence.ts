import { useEffect, useRef, useState } from 'react';
import { OVERLAY_EXIT, prefersReducedMotion } from '@/shared/lib/motion';

interface Presence {
  /** 是否仍应渲染：关闭后到退场结束前保持 true。 */
  mounted: boolean;
  /** 是否正在退场：用于挂 .is-closing，让 CSS 切到退场动画。 */
  closing: boolean;
}

/**
 * 条件渲染的浮层在卸载前把退场动画播完。
 *
 * 触发条件：open 由 true → false。open 重新变 true 时立刻取消卸载计时并回到入场动画，
 * 保证"快速开关"不会留下半透明的残影。减少动态效果时退场时长按 0 处理。
 */
export function usePresence(open: boolean, exitDuration = OVERLAY_EXIT): Presence {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const mountedRef = useRef(open);

  useEffect(() => {
    if (open) {
      mountedRef.current = true;
      setMounted(true);
      setClosing(false);
      return;
    }

    if (!mountedRef.current) return;

    setClosing(true);
    const timer = window.setTimeout(
      () => {
        mountedRef.current = false;
        setMounted(false);
        setClosing(false);
      },
      prefersReducedMotion() ? 0 : exitDuration,
    );

    return () => window.clearTimeout(timer);
  }, [open, exitDuration]);

  // open 当帧就要渲染（父组件已经收到 true），否则会多等一帧才出现
  return { mounted: mounted || open, closing: open ? false : closing };
}
