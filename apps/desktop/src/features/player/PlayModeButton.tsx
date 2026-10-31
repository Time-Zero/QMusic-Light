import type { PlayMode } from '@qmusic/shared-types';
import { ListOrdered, Repeat, Repeat1, Shuffle } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { usePlayerStore } from './player-store';

type ModeIcon = typeof Shuffle;

const MODES: Record<PlayMode, { label: string; Icon: ModeIcon }> = {
  shuffle: { label: '随机播放', Icon: Shuffle },
  order: { label: '顺序播放', Icon: ListOrdered },
  single: { label: '单曲循环', Icon: Repeat1 },
  list: { label: '列表循环', Icon: Repeat },
};

/**
 * 唯一的播放模式入口：点一下按「列表循环 → 单曲循环 → 随机 → 顺序」轮转，
 * 图标本身就是当前模式，不再拆成"随机"和"循环"两个按钮。
 */
export function PlayModeButton() {
  const mode = usePlayerStore((s) => s.mode);
  const cycleMode = usePlayerStore((s) => s.cycleMode);
  // 持久化数据可能来自更早版本，取不到时退回列表循环
  const { label, Icon } = MODES[mode] ?? MODES.list;

  return (
    <button
      type="button"
      className={cn('icon-btn', mode !== 'order' && 'is-active')}
      title={`${label}（点击切换）`}
      aria-label={`播放模式：${label}`}
      onClick={cycleMode}
    >
      <Icon />
    </button>
  );
}
