/**
 * 动效的运行时参数。时长只在这里写一次，CSS 侧对应 motion.css 的 --dur-exit。
 * 档位与优先级见 tokens.css 顶部的注释。
 */
export const OVERLAY_EXIT = 160;

/** 系统是否要求减少动态效果；环境没有 matchMedia（测试/旧内核）时按"不减少"处理。 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
