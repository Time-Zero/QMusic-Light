import { memo } from 'react';
import { formatDuration } from '@/shared/lib/format';
import { cn } from '@/shared/lib/cn';
import { usePlayerStore } from './player-store';

interface Props {
  className?: string;
}

/**
 * 播放位置文本。
 *
 * 单独成组件是为了把"每秒变一次的文字"和"整条播放条"解耦：
 * 选择器取整秒，同一秒内的多次状态写入不会触发渲染（zustand 对选择器结果做相等判断）。
 */
export const TrackTime = memo(function TrackTime({ className }: Props) {
  const seconds = usePlayerStore((s) => Math.floor(s.currentTime));
  return <span className={cn('time', className)}>{formatDuration(seconds)}</span>;
});
