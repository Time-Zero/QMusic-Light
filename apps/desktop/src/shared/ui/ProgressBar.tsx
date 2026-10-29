import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useRailWidth } from '@/shared/hooks/useRailWidth';
import { cn } from '@/shared/lib/cn';
import { subscribeProgress } from '@/shared/lib/progress-driver';

interface Props {
  /** 兜底总时长：音频元数据未就绪时用它当分母。 */
  max: number;
  onSeek: (value: number) => void;
  className?: string;
  ariaLabel?: string;
}

/**
 * 进度条：pointer capture 拖拽，拖动时只更新预览，松手才 seek（文档 §7.5）。
 *
 * 填充完全不经过 React：progress-driver 每帧只往根节点写一个 --p 变量，
 * 由 CSS 用 scaleX / translate3d 消费 —— 逐帧路径上没有 React 渲染，
 * 也没有布局与重绘。React 只负责"现在是否在拖拽"这一个离散状态。
 *
 * aria-valuenow 也由订阅回调按"整秒变化"写入，避免为了无障碍属性把组件
 * 拖回每秒一次的渲染。
 */
export function ProgressBar({ max, onSeek, className, ariaLabel = '播放进度' }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const draggingRef = useRef(false);
  const maxRef = useRef(max);
  const secondsRef = useRef(0);
  const wholeRef = useRef(-1);

  const [dragging, setDragging] = useState(false);

  maxRef.current = max;
  useRailWidth(barRef);

  const paint = useCallback((ratio: number) => {
    barRef.current?.style.setProperty('--p', ratio.toFixed(5));
  }, []);

  const ratioOf = useCallback((seconds: number, duration: number) => {
    const base = duration > 0 ? duration : maxRef.current;
    if (base <= 0) return 0;
    return Math.min(Math.max(seconds / base, 0), 1);
  }, []);

  // 挂载时先把无障碍属性落到合法值上，之后由订阅回调按整秒更新
  useLayoutEffect(() => {
    barRef.current?.setAttribute('aria-valuenow', '0');
  }, []);

  // 用 layout effect 订阅：sink 会同步吐一次当前进度，保证首帧就画在正确位置，
  // 不会出现"先空一下再跳到当前进度"的闪烁
  useLayoutEffect(
    () =>
      subscribeProgress((snapshot) => {
        secondsRef.current = snapshot.seconds;
        const whole = Math.floor(snapshot.seconds);
        if (whole !== wholeRef.current) {
          wholeRef.current = whole;
          barRef.current?.setAttribute('aria-valuenow', String(whole));
        }
        if (draggingRef.current) return;
        paint(ratioOf(snapshot.seconds, snapshot.duration));
      }),
    [paint, ratioOf],
  );

  const ratioAt = (clientX: number) => {
    const rect = rectRef.current;
    if (!rect || rect.width === 0) return 0;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    // 整个拖拽期间只读一次几何：每次 pointermove 读 rect 会强制同步布局
    rectRef.current = event.currentTarget.getBoundingClientRect();
    draggingRef.current = true;
    setDragging(true);
    paint(ratioAt(event.clientX));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    paint(ratioAt(event.clientX));
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const ratio = ratioAt(event.clientX);
    draggingRef.current = false;
    rectRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    onSeek(ratio * maxRef.current);
  };

  return (
    <div
      ref={barRef}
      className={cn('bar', dragging && 'dragging', className)}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        const delta = event.key === 'ArrowLeft' ? -5 : 5;
        onSeek(Math.min(Math.max(secondsRef.current + delta, 0), max || secondsRef.current + delta));
      }}
    >
      <div className="rail">
        <div className="fill" />
      </div>
      <div className="knob" />
    </div>
  );
}
