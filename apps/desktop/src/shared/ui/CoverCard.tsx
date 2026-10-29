import { Play } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { coverVars } from '@/shared/lib/color';
import { CoverImage } from './CoverImage';

interface Props {
  title: string;
  subtitle?: string;
  cover?: string;
  seed: string | number;
  rank?: number;
  glyph?: string;
  onOpen?: () => void;
  onPlay?: () => void;
}

export function CoverCard({ title, subtitle, cover, seed, rank, glyph, onOpen, onPlay }: Props) {
  const activate = () => onOpen?.();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  };

  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      style={coverVars(seed)}
      onClick={activate}
      onKeyDown={onKeyDown}
      aria-label={title}
    >
      <div className="art">
        <CoverImage src={cover} glyph={glyph} alt={title} />
        {rank ? <span className="rank">{rank}</span> : null}
        {onPlay ? (
          <button
            type="button"
            className="play"
            title="播放"
            onClick={(event) => {
              event.stopPropagation();
              onPlay();
            }}
          >
            <Play />
          </button>
        ) : null}
      </div>
      <div className="name" title={title}>
        {title}
      </div>
      {subtitle ? (
        <div className="by" title={subtitle}>
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}
