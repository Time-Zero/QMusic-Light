/**
 * 动效档位：决定动画走合成还是走兼容路径。
 *
 *   full   —— 默认。transform / opacity + rAF 直写，逐帧路径不进入布局与重绘。
 *   lite   —— 合成能力不足（软件渲染、低端集显、系统要求减少动态效果）。
 *             进度条退回 width / left，装饰性循环动画停用，级联延迟清零。
 *   legacy —— A/B 对比用，强制走改造前的属性路径，用来量化改造收益。
 *
 * 档位写在 <html data-motion="...">，CSS 侧的回退分支见 motion.css 末尾。
 */

export type MotionTier = 'full' | 'lite' | 'legacy';

const STORAGE_KEY = 'qmusic:motion';
const TIERS: readonly MotionTier[] = ['full', 'lite', 'legacy'];

let current: MotionTier = 'full';
/** 是否由 URL / 存储显式指定；显式指定时不再被帧预算探测覆盖。 */
let explicit = false;

function readOverride(): MotionTier | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('motion');
    if (fromQuery && TIERS.includes(fromQuery as MotionTier)) return fromQuery as MotionTier;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && TIERS.includes(stored as MotionTier)) return stored as MotionTier;
  } catch {
    // 隐私模式或受限 WebView 下 localStorage 会抛错，忽略即可
  }
  return null;
}

export function getMotionTier(): MotionTier {
  return current;
}

/** 是否允许播放装饰性动画（循环动画、级联延迟）。 */
export function allowsDecoration(): boolean {
  return current === 'full' || current === 'legacy';
}

export function applyMotionTier(tier?: MotionTier): MotionTier {
  const override = tier ?? readOverride();
  explicit = Boolean(override);
  const systemReduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  current = override ?? (systemReduced ? 'lite' : 'full');
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.motion = current;
  }
  return current;
}

/**
 * 采样 60 帧判断合成能力，不达标就把档位降到 lite。
 *
 * 两道阈值同时满足才降级（p95 超 24ms 且慢帧占比 ≥ 15%），避免一次 GC 或
 * 图片解码就被误判成"低端机"。采样推迟到启动 4s 后，避开首屏字体光栅化与
 * 资源加载的高噪声区间；开发模式下跳过，免得 HMR 让本地调试突然降档。
 */
export function watchFrameBudget(): void {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  if (import.meta.env.DEV) return;

  window.setTimeout(() => {
    if (explicit || current !== 'full') return;

    const deltas: number[] = [];
    let previous = performance.now();

    const loop = (now: number) => {
      deltas.push(now - previous);
      previous = now;
      if (deltas.length < 60) {
        requestAnimationFrame(loop);
        return;
      }

      const sorted = [...deltas].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      const slow = deltas.filter((delta) => delta > 24).length;

      if (p95 > 24 && slow / deltas.length >= 0.15) {
        applyMotionTier('lite');
      }
    };

    requestAnimationFrame(loop);
  }, 4000);
}
