import { describe, expect, it } from 'vitest';
import { estimateSeconds } from './progress-driver';

const anchor = { time: 10, at: 1_000 };

function estimate(overrides: Partial<Parameters<typeof estimateSeconds>[0]> = {}) {
  return estimateSeconds({
    anchor,
    clock: 1_000,
    paused: false,
    currentTime: 10,
    duration: 0,
    ...overrides,
  });
}

describe('estimateSeconds', () => {
  it('锚点当帧返回锚点时间', () => {
    expect(estimate()).toBe(10);
  });

  it('播放中按单调时钟外推，250ms 补出 0.25 秒', () => {
    expect(estimate({ clock: 1_250 })).toBeCloseTo(10.25, 5);
  });

  it('暂停时以元素真实值为准，不外推', () => {
    expect(estimate({ paused: true, currentTime: 3, clock: 9_999 })).toBe(3);
  });

  it('外推不超过总时长', () => {
    expect(estimate({ clock: 60_000, duration: 12 })).toBe(12);
  });

  it('总时长未知时不夹上限', () => {
    expect(estimate({ clock: 60_000, duration: 0 })).toBe(69);
  });

  it('外推出负值时夹到 0', () => {
    expect(estimate({ anchor: { time: 0, at: 1_000 }, clock: 0 })).toBe(0);
  });
});
