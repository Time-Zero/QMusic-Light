import { useLayoutEffect, type RefObject } from 'react';

/**
 * 把控件宽度写进 --rail-w，让旋钮能用 translate3d 定位。
 *
 * 直接用 `left: %` 定位会触发布局；改成 transform 之后必须知道像素宽度，
 * 而每帧读 clientWidth 会强制同步布局 —— 于是把测量收在 ResizeObserver 里，
 * 逐帧路径只写一个数字。
 */
export function useRailWidth(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    let last = -1;
    const apply = () => {
      const width = node.clientWidth;
      if (width === last) return;
      last = width;
      node.style.setProperty('--rail-w', `${width}px`);
    };

    apply();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply);
      return () => window.removeEventListener('resize', apply);
    }

    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
}
