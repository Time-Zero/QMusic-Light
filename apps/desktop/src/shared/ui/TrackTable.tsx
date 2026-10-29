import { useVirtualizer } from '@tanstack/react-virtual';
import { Heart } from 'lucide-react';
import { useRef, type CSSProperties } from 'react';
import type { Song } from '@qmusic/shared-types';
import { coverVars } from '@/shared/lib/color';
import { cn } from '@/shared/lib/cn';
import { formatDuration, singerNames } from '@/shared/lib/format';
import { CoverImage } from './CoverImage';

interface Props {
  songs: Song[];
  playingMid?: string;
  playing?: boolean;
  onPlay: (index: number) => void;
  likedMids?: ReadonlySet<string>;
  onToggleLike?: (song: Song) => void;
  height?: string | number;
  showAlbum?: boolean;
}

export function TrackTable({
  songs,
  playingMid,
  playing,
  onPlay,
  likedMids,
  onToggleLike,
  height = 'min(56vh, 520px)',
  showAlbum = true,
}: Props) {
  const virtual = songs.length > 60;
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: songs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  const scrollStyle: CSSProperties = { maxHeight: height };

  return (
    <div className="track-table">
      <div className="track-head" aria-hidden="true">
        <span style={{ textAlign: 'center' }}>#</span>
        <span>标题</span>
        <span>歌手</span>
        {showAlbum ? <span>专辑</span> : <span />}
        <span style={{ textAlign: 'right' }}>时长</span>
        <span />
      </div>
      <div className="track-scroll" ref={parentRef} style={scrollStyle}>
        {virtual ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const song = songs[item.index];
              return (
                <div
                  key={`${song.mid}-${item.index}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <TrackRow
                    song={song}
                    index={item.index}
                    playingMid={playingMid}
                    playing={playing}
                    onPlay={onPlay}
                    liked={likedMids?.has(song.mid)}
                    onToggleLike={onToggleLike}
                    showAlbum={showAlbum}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          songs.map((song, index) => (
            <TrackRow
              key={`${song.mid}-${index}`}
              song={song}
              index={index}
              playingMid={playingMid}
              playing={playing}
              onPlay={onPlay}
              liked={likedMids?.has(song.mid)}
              onToggleLike={onToggleLike}
              showAlbum={showAlbum}
            />
          ))
        )}
      </div>
    </div>
  );
}

interface RowProps {
  song: Song;
  index: number;
  playingMid?: string;
  playing?: boolean;
  onPlay: (index: number) => void;
  liked?: boolean;
  onToggleLike?: (song: Song) => void;
  showAlbum: boolean;
}

function TrackRow({
  song,
  index,
  playingMid,
  playing,
  onPlay,
  liked,
  onToggleLike,
  showAlbum,
}: RowProps) {
  const isCurrent = song.mid === playingMid;
  const isPlaying = isCurrent && Boolean(playing);

  const badge =
    song.maxQuality === 'flac' ? 'SQ' : song.maxQuality === '320' ? 'HQ' : undefined;

  return (
    <div
      className={cn('track', isCurrent && 'playing')}
      style={coverVars(song.mid)}
      role="button"
      tabIndex={0}
      onClick={() => onPlay(index)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onPlay(index);
        }
      }}
    >
      <div className="no">
        {isPlaying ? (
          <span className="eq" aria-label="正在播放">
            <i />
            <i />
            <i />
          </span>
        ) : (
          index + 1
        )}
      </div>
      <div className="t">
        <div className="mini">
          <CoverImage src={song.cover} alt={song.name} />
        </div>
        <div className="title">
          <span className="ellipsis">{song.name}</span>
          {badge ? <em>{badge}</em> : null}
          {song.payPlay === 1 ? <em className="vip">VIP</em> : null}
        </div>
      </div>
      <div className="artist">{singerNames(song.singers)}</div>
      {showAlbum ? <div className="album">{song.albumName || '—'}</div> : <div />}
      <div className="dur">{formatDuration(song.duration)}</div>
      <button
        type="button"
        className={cn('act', liked && 'liked')}
        title={liked ? '取消喜欢' : '喜欢'}
        aria-label={liked ? '取消喜欢' : '喜欢'}
        onClick={(event) => {
          event.stopPropagation();
          onToggleLike?.(song);
        }}
      >
        <Heart fill={liked ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}
