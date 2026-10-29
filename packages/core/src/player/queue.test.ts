import { describe, expect, it } from 'vitest';
import type { Song } from '@qmusic/shared-types';
import {
  enqueue,
  formatDuration,
  formatTotalDuration,
  moveItem,
  nextIndex,
  prevIndex,
  totalDuration,
} from './queue';

const song = (mid: string, duration = 100): Song => ({
  mid,
  id: 0,
  name: mid,
  title: mid,
  albumMid: '',
  albumName: '',
  singers: [],
  cover: '',
  duration,
  mediaMid: mid,
  payPlay: 0,
  playable: true,
  songType: 0,
});

describe('队列推进', () => {
  it('顺序模式循环播放', () => {
    expect(nextIndex('order', 0, 3)).toBe(1);
    expect(nextIndex('order', 2, 3)).toBe(0);
    expect(nextIndex('order', -1, 3)).toBe(0);
  });

  it('单曲循环：自动播放回到本曲，手动切歌去下一首', () => {
    expect(nextIndex('single', 1, 3, Math.random, false)).toBe(1);
    expect(nextIndex('single', 1, 3, Math.random, true)).toBe(2);
  });

  it('随机模式不会选到当前曲目', () => {
    for (const random of [0, 0.2, 0.5, 0.99]) {
      const rng = () => random;
      const target = nextIndex('shuffle', 1, 4, rng);
      expect(target).not.toBe(1);
      expect(target).toBeGreaterThanOrEqual(0);
      expect(target).toBeLessThan(4);
    }
  });

  it('空队列与单曲队列', () => {
    expect(nextIndex('order', -1, 0)).toBe(-1);
    expect(nextIndex('order', 0, 1)).toBe(0);
    expect(prevIndex('order', -1, 0)).toBe(-1);
  });

  it('上一首顺序回退', () => {
    expect(prevIndex('order', 0, 3)).toBe(2);
    expect(prevIndex('order', 2, 3)).toBe(1);
  });
});

describe('队列编辑', () => {
  it('enqueue 去重', () => {
    const queue = [song('a'), song('b')];
    const result = enqueue(queue, [song('b'), song('c')]);
    expect(result.added).toBe(1);
    expect(result.queue.map((s) => s.mid)).toEqual(['a', 'b', 'c']);
  });

  it('moveItem 移动元素', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 5, 2)).toEqual(['a', 'b', 'c']);
  });
});

describe('时长格式化', () => {
  it('mm:ss', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(156)).toBe('02:36');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('总计时长', () => {
    expect(totalDuration([song('a', 60), song('b', 120)])).toBe(180);
    expect(formatTotalDuration(180)).toBe('3 分钟');
    expect(formatTotalDuration(3900)).toBe('1 小时 5 分');
  });
});
