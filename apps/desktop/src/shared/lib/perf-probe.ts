/**
 * 帧率探针：给"动画是否真的掉帧"一个可复现的数字，而不是靠肉眼。
 *
 * 用法（DevTools 控制台）：
 *   await __qmusicProbe(10000)   // 采样 10s
 *
 * 判定口径见 docs/animation-gpu-migration.md §6：
 *   p95 ≤ 16.7ms、jankRatio < 1%、worst ≤ 33ms 视为通过。
 */

export interface FrameReport {
  frames: number;
  /** 帧时长的中位数 / 95 分位 / 99 分位（毫秒）。 */
  p50: number;
  p95: number;
  p99: number;
  /** 超过 1.5 帧预算的帧数。 */
  dropped: number;
  jankRatio: number;
  worst: number;
  /** 采样期间的平均 FPS，便于与 DevTools 的 FPS 表对照。 */
  fps: number;
}

const FRAME_BUDGET = 1000 / 60;

export function probeFrames(ms = 10_000): Promise<FrameReport> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let previous = performance.now();
    const deadline = previous + ms;

    const loop = (now: number) => {
      deltas.push(now - previous);
      previous = now;
      if (now < deadline) {
        requestAnimationFrame(loop);
        return;
      }

      const sorted = [...deltas].sort((a, b) => a - b);
      const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
      const dropped = deltas.filter((delta) => delta > FRAME_BUDGET * 1.5).length;
      const total = deltas.reduce((sum, delta) => sum + delta, 0);

      resolve({
        frames: deltas.length,
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        dropped,
        jankRatio: deltas.length > 0 ? dropped / deltas.length : 0,
        worst: sorted.at(-1) ?? 0,
        fps: total > 0 ? (deltas.length / total) * 1000 : 0,
      });
    };

    requestAnimationFrame(loop);
  });
}

/** 开发期把探针挂到 window，方便控制台直接调用。 */
export function installProbe(): void {
  if (!import.meta.env.DEV) return;
  (window as unknown as Record<string, unknown>).__qmusicProbe = probeFrames;
}
