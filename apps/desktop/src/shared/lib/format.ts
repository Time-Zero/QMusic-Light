export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function formatTotalDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

export function formatCount(value: number): string {
  if (!value || value < 0) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(value);
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function formatDateCN(date = new Date()): string {
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatWeekday(date = new Date()): string {
  return `星期${WEEK[date.getDay()]}`;
}

export function todayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function singerNames(singers: { name: string }[]): string {
  return singers.map((s) => s.name).filter(Boolean).join(' / ') || '未知歌手';
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return /^[a-zA-Z]/.test(trimmed) ? trimmed.slice(0, 1).toUpperCase() : trimmed.slice(-1);
}

export function groupLabel(count: number, unit = '首'): string {
  return `${count} ${unit}`;
}

/** 缓存占用：1.2 GB / 640 MB / 512 B */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const text = size >= 10 ? size.toFixed(0) : size.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[index]}`;
}
