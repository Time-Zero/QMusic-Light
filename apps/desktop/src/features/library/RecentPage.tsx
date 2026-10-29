import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Play, Trash2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useCore } from '@/app/core-context';
import { usePlayerStore } from '@/features/player/player-store';
import { formatTotalDuration } from '@/shared/lib/format';
import { EmptyState } from '@/shared/ui/EmptyState';
import { TracksSkeleton } from '@/shared/ui/Skeleton';
import { TrackTable } from '@/shared/ui/TrackTable';
import { toast, useUiStore } from '@/shared/ui/ui-store';

export default function RecentPage() {
  const core = useCore();
  const queryClient = useQueryClient();
  const setCrumb = useUiStore((s) => s.setCrumb);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const playingMid = usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index]?.mid : undefined));
  const playing = usePlayerStore((s) => s.playing);

  useEffect(() => setCrumb('最近播放'), [setCrumb]);

  const recent = useQuery({
    queryKey: ['recent', 200],
    queryFn: () => core.repo.recent(200),
    staleTime: 10_000,
  });

  const songs = useMemo(() => recent.data?.map((item) => item.song) ?? [], [recent.data]);
  const totalDuration = songs.reduce((sum, song) => sum + song.duration, 0);

  const clear = async () => {
    await core.repo.clearHistory();
    await queryClient.invalidateQueries({ queryKey: ['recent'] });
    toast('已清空最近播放', 'success');
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">最近播放</h1>
          <p className="page-sub">
            {songs.length > 0
              ? `${songs.length} 首 · ${formatTotalDuration(totalDuration)} · 只记录在本机`
              : '只记录在本机，保留最近 300 条'}
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={songs.length === 0}
            onClick={() => void playQueue(songs, 0, '最近播放')}
          >
            <Play />
            播放全部
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={songs.length === 0}
            onClick={() => void clear()}
          >
            <Trash2 />
            清空
          </button>
        </div>
      </div>

      {recent.isLoading ? (
        <TracksSkeleton count={8} />
      ) : songs.length === 0 ? (
        <EmptyState
          icon={<History />}
          title="还没有播放记录"
          description="播放一首歌之后，这里会留下最近 300 条记录，并按歌曲去重展示。"
        />
      ) : (
        <TrackTable
          songs={songs}
          playingMid={playingMid}
          playing={playing}
          onPlay={(index) => void playQueue(songs, index, '最近播放')}
        />
      )}
    </div>
  );
}
