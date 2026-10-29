import type { CSSProperties } from 'react';

export function Skeleton({ width, height, radius, style }: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  );
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="cards" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <Skeleton height="auto" style={{ aspectRatio: '1 / 1', borderRadius: 13 }} />
          <Skeleton height={12} width="72%" style={{ marginTop: 10 }} />
          <Skeleton height={10} width="46%" style={{ marginTop: 7 }} />
        </div>
      ))}
    </div>
  );
}

export function TracksSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="track-table" aria-hidden="true">
      <div className="track-head" />
      {Array.from({ length: count }).map((_, i) => (
        <div className="track" key={i} style={{ pointerEvents: 'none' }}>
          <Skeleton width={18} height={12} />
          <div className="t">
            <Skeleton width={34} height={34} radius={8} />
            <Skeleton width="56%" height={12} />
          </div>
          <Skeleton width="52%" height={11} />
          <Skeleton width="46%" height={11} />
          <Skeleton width={34} height={10} />
          <span />
        </div>
      ))}
    </div>
  );
}

export function PageLoading({ label = '加载中' }: { label?: string }) {
  return (
    <div className="loading-inline" style={{ padding: '22px 0' }}>
      <span className="spin" aria-hidden="true">
        ◐
      </span>
      {label}…
    </div>
  );
}
