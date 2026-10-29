import { cn } from '@/shared/lib/cn';
import { useUiStore } from './ui-store';

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div
          key={item.id}
          className={cn('toast', item.type, item.leaving && 'leaving')}
          onClick={() => dismiss(item.id)}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
