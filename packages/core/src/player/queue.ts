import type { PlayMode, Song } from '@qmusic/shared-types';

export type Rng = () => number;

/**
 * 计算下一首索引。
 * - order：顺序循环
 * - single：自动播放结束回到本曲；手动切歌仍走下一首
 * - shuffle：随机但不重复当前曲（列表 > 1 时）
 */
export function nextIndex(
  mode: PlayMode,
  current: number,
  length: number,
  rng: Rng = Math.random,
  manual = false,
): number {
  if (length <= 0) return -1;
  if (length === 1) return 0;
  if (mode === 'single' && !manual) return Math.max(current, 0);
  if (mode === 'shuffle') {
    const base = current < 0 ? 0 : current;
    let candidate = Math.floor(rng() * (length - 1));
    if (candidate >= base) candidate += 1;
    return Math.min(Math.max(candidate, 0), length - 1);
  }
  const base = current < 0 ? -1 : current;
  return (base + 1) % length;
}

export function prevIndex(mode: PlayMode, current: number, length: number, rng: Rng = Math.random): number {
  if (length <= 0) return -1;
  if (length === 1) return 0;
  if (mode === 'shuffle') {
    const base = Math.max(current, 0);
    let candidate = Math.floor(rng() * (length - 1));
    if (candidate >= base) candidate += 1;
    return Math.min(Math.max(candidate, 0), length - 1);
  }
  const base = current < 0 ? 0 : current;
  return (base - 1 + length) % length;
}

/** 队列插入策略：去重后追加到当前曲之后，保持正在播放的曲目不动 */
export function enqueue(queue: Song[], songs: Song[], insertAfter = false): { queue: Song[]; added: number } {
  const seen = new Set(queue.map((s) => s.mid));
  const fresh = songs.filter((s) => !seen.has(s.mid));
  if (fresh.length === 0) return { queue, added: 0 };
  return {
    queue: insertAfter ? [...queue, ...fresh] : [...queue, ...fresh],
    added: fresh.length,
  };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function totalDuration(songs: Song[]): number {
  return songs.reduce((sum, s) => sum + (s.duration || 0), 0);
}

export function formatTotalDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}
