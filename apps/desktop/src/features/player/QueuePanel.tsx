import { ListMusic, X } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '@/shared/lib/cn';
import { formatDuration, formatTotalDuration, singerNames } from '@/shared/lib/format';
import { usePlayerStore } from './player-store';

export function QueuePanel({ closing = false }: { closing?: boolean }) {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const playing = usePlayerStore((s) => s.playing);
  const setShowQueue = usePlayerStore((s) => s.setShowQueue);
  const playAt = usePlayerStore((s) => s.playAt);
  const removeAt = usePlayerStore((s) => s.removeAt);
  const clearQueue = usePlayerStore((s) => s.clearQueue);

  const total = useMemo(() => queue.reduce((sum, song) => sum + (song.duration || 0), 0), [queue]);

  return (
    <>
      <div
        className={cn('drawer-backdrop', closing && 'is-closing')}
        onClick={() => setShowQueue(false)}
        aria-hidden="true"
      />
      <aside
        className={cn('queue-panel', closing && 'is-closing')}
        aria-label="播放队列"
        inert={closing || undefined}
      >
        <div className="queue-head">
          <h2>播放队列</h2>
          <span className="sub">{queue.length} 首</span>
          <button
            type="button"
            className="icon-btn"
            title="关闭"
            onClick={() => setShowQueue(false)}
          >
            <X />
          </button>
        </div>

        <div className="queue-list">
          {queue.length === 0 ? (
            <div className="empty" style={{ margin: 12 }}>
              <ListMusic />
              <strong>队列是空的</strong>
              <p>从歌单里点一首歌，或直接点播放全部。</p>
            </div>
          ) : (
            queue.map((song, i) => (
              <div
                key={`${song.mid}-${i}`}
                className={cn('queue-item', i === index && 'active')}
                role="button"
                tabIndex={0}
                onClick={() => void playAt(i)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void playAt(i);
                  }
                }}
              >
                <span className="idx">{i === index && playing ? '▶' : i + 1}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="qi-title">{song.name}</span>
                  <span className="qi-sub">{singerNames(song.singers)}</span>
                </span>
                <span className="qi-end">
                  <span className="qi-dur">{formatDuration(song.duration)}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    title="从队列移除"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeAt(i);
                    }}
                  >
                    <X />
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="queue-foot">
          <span>共 {queue.length} 首</span>
          <span>{formatTotalDuration(total)}</span>
          <button
            type="button"
            className="pill"
            onClick={clearQueue}
            disabled={queue.length === 0}
          >
            清空
          </button>
        </div>
      </aside>
    </>
  );
}
