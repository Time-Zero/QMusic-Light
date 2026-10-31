import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TTL } from '@core';
import type { FeedCard, Playlist, Song } from '@qmusic/shared-types';
import { ArrowRight, Heart, LogIn, MoreHorizontal, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useAccount } from '@/features/auth/session-store';
import { usePlayerStore } from '@/features/player/player-store';
import { cn } from '@/shared/lib/cn';
import { coverVars } from '@/shared/lib/color';
import {
  formatCount,
  formatDateCN,
  formatDuration,
  formatTotalDuration,
  formatWeekday,
  singerNames,
} from '@/shared/lib/format';
import { CoverCard } from '@/shared/ui/CoverCard';
import { EmptyState } from '@/shared/ui/EmptyState';
import { SectionHeader } from '@/shared/ui/SectionHeader';
import { CardGridSkeleton, TracksSkeleton } from '@/shared/ui/Skeleton';
import { TrackTable } from '@/shared/ui/TrackTable';
import { toast, useUiStore } from '@/shared/ui/ui-store';

/** 推荐流里的功能入口卡没有歌单 id，按标题/id 映射到站内能力 */
const isRadioCard = (card: FeedCard) => card.id === '99' || card.title.includes('猜你喜欢');
const isRadarCard = (card: FeedCard) => card.id === '22000' || card.title.includes('雷达模式');
const isDailyCard = (card: FeedCard) => /每日\s*30\s*首/.test(card.title);

/** 只保留站内已实现的卡片；星光农场/快听/签到等活动入口没有对应接口，直接不下发到界面 */
const isSupportedCard = (card: FeedCard) =>
  card.type === 'song' ||
  card.type === 'playlist' ||
  isRadioCard(card) ||
  isRadarCard(card) ||
  isDailyCard(card);

/** 功能入口卡上游不给封面，用图标兜底 */
const feedCardGlyph = (card: FeedCard) => {
  if (isRadioCard(card)) return '♥';
  if (isRadarCard(card)) return '◉';
  if (isDailyCard(card)) return '30';
  return undefined;
};

export default function HomePage() {
  const core = useCore();
  const navigate = useNavigate();
  const account = useAccount();
  const queryClient = useQueryClient();
  const setCrumb = useUiStore((s) => s.setCrumb);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const playSong = usePlayerStore((s) => s.playSong);
  const generating = useRef(false);

  useEffect(() => setCrumb('发现'), [setCrumb]);

  const feed = useQuery({
    queryKey: ['feed', account?.uin ?? 'guest'],
    queryFn: () => core.feed.sections(account),
    staleTime: TTL.feed,
  });

  const square = useQuery({
    queryKey: ['square', 18],
    queryFn: () => core.feed.square(18),
    staleTime: TTL.square,
  });

  const daily = useQuery({
    queryKey: ['daily', account?.uin],
    queryFn: () => core.feed.daily(account!),
    enabled: Boolean(account),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const dailyDetail = useQuery({
    queryKey: ['daily-detail', daily.data?.playlistId],
    queryFn: () => core.playlists.detail(daily.data!.playlistId, { kind: 'daily', account: account!, num: 30 }),
    enabled: Boolean(daily.data?.playlistId && account),
    staleTime: TTL.playlistDetail,
    retry: 0,
  });

  const recent = useQuery({
    queryKey: ['recent', 8],
    queryFn: () => core.repo.recent(8),
    staleTime: 10_000,
  });

  const heroPlaylist = dailyDetail.data?.playlist;
  const heroSongs = daily.data?.songs ?? [];
  const fallbackPlaylist = square.data?.[0];

  const heroTitle = heroPlaylist?.title || fallbackPlaylist?.title || '发现好音乐';
  const heroTags = useMemo(() => {
    const tags = (heroPlaylist?.tags ?? fallbackPlaylist?.tags ?? []).filter(Boolean);
    if (tags.length > 0) return tags.slice(0, 4);
    return ['华语流行', '独立电子', 'City Pop'];
  }, [heroPlaylist?.tags, fallbackPlaylist?.tags]);

  const playHero = async () => {
    if (heroSongs.length > 0) {
      await playQueue(heroSongs, 0, '每日 30 首');
      return;
    }
    if (fallbackPlaylist) {
      try {
        const detail = await core.playlists.detail(fallbackPlaylist.id, { kind: 'public' });
        await playQueue(detail.songs, 0, fallbackPlaylist.title);
      } catch (error) {
        toast(error instanceof Error ? error.message : '歌单加载失败', 'error');
      }
    }
  };

  const playGenerated = async (
    kind: 'radio' | 'radar',
    load: () => Promise<Song[]>,
    label: string,
  ) => {
    if (generating.current) return;
    generating.current = true;
    try {
      const songs = await queryClient.fetchQuery({
        queryKey: [kind, account?.uin ?? 'guest', label],
        queryFn: load,
        staleTime: TTL.feed,
      });
      if (songs.length === 0) {
        toast(`${label}暂时没有返回歌曲，稍后再试`, 'error');
        return;
      }
      await playQueue(songs, 0, label);
    } catch (error) {
      toast(error instanceof Error ? error.message : `${label}加载失败`, 'error');
    } finally {
      generating.current = false;
    }
  };

  const playRadio = () => playGenerated('radio', () => core.feed.radio(15), '猜你喜欢');
  const playRadar = () => playGenerated('radar', () => core.feed.radarSongs(30), '雷达模式');

  const openCard = (card: FeedCard) => {
    if (card.type === 'playlist' && card.playlistId) {
      navigate(`/playlist/${card.playlistId}?kind=public`);
      return;
    }
    if (card.type === 'song' && card.song) {
      void playSong(card.song);
      return;
    }
    if (isRadioCard(card)) {
      void playRadio();
      return;
    }
    if (isRadarCard(card)) {
      void playRadar();
      return;
    }
    if (isDailyCard(card)) {
      navigate('/daily');
      return;
    }
  };

  const playCard = (card: FeedCard) => {
    if (card.type === 'song' && card.song) void playSong(card.song);
    else if (isRadioCard(card)) void playRadio();
    else if (isRadarCard(card)) void playRadar();
    else openCard(card);
  };

  const openPlaylist = (playlist: Playlist) => navigate(`/playlist/${playlist.id}?kind=public`);

  const recentSongs: Song[] = useMemo(() => recent.data?.map((item) => item.song) ?? [], [recent.data]);

  const playingMid = usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index]?.mid : undefined));
  const playing = usePlayerStore((s) => s.playing);

  // 首个仍有可展示卡片的货架，避免整架都是活动入口时标题/副标题对不上内容
  const feedSection = useMemo(
    () => (feed.data ?? []).find((section) => section.cards.some(isSupportedCard)),
    [feed.data],
  );
  const feedCards = useMemo(() => {
    const seen = new Set<string>();
    const cards: FeedCard[] = [];
    for (const section of feed.data ?? []) {
      for (const card of section.cards) {
        // 星光农场、快听、签到等入口没有对应 CGI，站内无法还原，直接过滤掉
        if (!isSupportedCard(card)) continue;
        const key = `${card.type}-${card.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push(card);
      }
    }
    // 匿名推荐流以歌单卡为主，不足 6 张时用编辑精选补齐（不重复）
    for (const playlist of square.data ?? []) {
      if (cards.length >= 6) break;
      const key = `playlist-${playlist.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({
        type: 'playlist',
        id: String(playlist.id),
        title: playlist.title,
        subtitle: `${playlist.songCount} 首 · ${formatCount(playlist.playCount)} 播放`,
        cover: playlist.cover,
        playlistId: playlist.id,
      });
    }
    return cards;
  }, [feed.data, square.data]);

  // 猜你喜欢是功能入口卡，上游不返回封面；用个性电台首曲的专辑封面补上
  const needsRadioCover = feedCards.some((card) => isRadioCard(card) && !card.cover);
  const radioCover = useQuery({
    queryKey: ['radio-cover', account?.uin ?? 'guest'],
    queryFn: async () => (await core.feed.radio(1))[0]?.cover ?? '',
    enabled: Boolean(account) && needsRadioCover,
    staleTime: TTL.feed,
    retry: 0,
  });

  const cardCover = (card: FeedCard) =>
    card.cover || (isRadioCard(card) ? (radioCover.data ?? '') : '');

  return (
    <div>
      <section className="hero" style={heroPlaylist ? coverVars(heroPlaylist.id) : undefined}>
        <div className="hero-body">
          <div className="hero-kicker">
            <span>{heroSongs.length > 0 ? '每日 30 首' : '编辑精选'}</span>
            <span>
              {formatDateCN()} {formatWeekday()}
            </span>
          </div>
          <h1>{heroTitle}</h1>
          <div className="hero-meta">
            {heroPlaylist ? (
              <>
                <span>{heroPlaylist.creator || 'QQ 音乐'}</span>
                <i />
                <span>{heroPlaylist.songCount || heroSongs.length} 首</span>
                {heroSongs.length > 0 ? (
                  <>
                    <i />
                    <span>{formatTotalDuration(heroSongs.reduce((n, s) => n + s.duration, 0))}</span>
                  </>
                ) : null}
              </>
            ) : fallbackPlaylist ? (
              <>
                <span>{fallbackPlaylist.creator || 'QQ 音乐编辑部'}</span>
                <i />
                <span>{fallbackPlaylist.songCount} 首</span>
                <i />
                <span>{formatCount(fallbackPlaylist.playCount)} 播放</span>
              </>
            ) : (
              <span>先逛后登录：发现页内容匿名可读</span>
            )}
          </div>
          {heroPlaylist?.description ? <p className="hero-desc">{heroPlaylist.description}</p> : null}
          <div className="hero-actions">
            <button type="button" className="btn btn-primary" onClick={() => void playHero()}>
              <Play />
              播放全部
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                heroSongs.length > 0
                  ? navigate('/daily')
                  : fallbackPlaylist
                    ? openPlaylist(fallbackPlaylist)
                    : undefined
              }
            >
              {heroSongs.length > 0 ? '查看每日歌单' : '查看歌单'}
              <ArrowRight />
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              title="更多"
              onClick={() => toast('收藏 / 分享歌单属于 P2 写接口，当前版本暂未开放')}
            >
              <MoreHorizontal />
            </button>
          </div>
        </div>
        {heroSongs.length > 0 ? (
          <ol className="hero-clips">
            {heroSongs.slice(0, 4).map((song, index) => (
              <li key={song.mid}>
                <button
                  type="button"
                  className={cn('clip', index === 0 && 'is-current')}
                  onClick={() => void playQueue(heroSongs, index, '每日 30 首')}
                  title={`播放 ${song.name}`}
                >
                  <span className="clip-tone" aria-hidden="true" />
                  <span className="clip-name">{song.name}</span>
                  <span className="clip-who">{singerNames(song.singers)}</span>
                  <span className="clip-time">{formatDuration(song.duration)}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <div className="hero-aside">
            <div className="lab">今日口味</div>
            <div className="chips">
              {heroTags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <div className="streak">
              <b>{fallbackPlaylist?.songCount || 0}</b>首 · 编辑精选
            </div>
          </div>
        )}
      </section>

      {!account ? (
        <div className="guest-banner">
          <div>
            <strong>先逛后登录</strong>
            <p>匿名可浏览推荐与公开歌单；每日 30 首、我的歌单与播放需要扫码登录。</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/login')}>
            <LogIn />
            扫码登录
          </button>
        </div>
      ) : null}

      {feed.isError ? (
        <div className="error-banner" style={{ marginTop: 16 }}>
          <TriangleAlert />
          推荐流加载失败：{feed.error instanceof Error ? feed.error.message : '未知错误'}
          <button type="button" className="pill" style={{ marginLeft: 'auto' }} onClick={() => void feed.refetch()}>
            <RefreshCw />
            重试
          </button>
        </div>
      ) : null}

      <section className="section">
        <SectionHeader
          title="今日精选"
          subtitle={feedSection?.subtitle || '按口味排序 · 每天 0 点更新'}
          action={
            <button type="button" className="more" onClick={() => void feed.refetch()}>
              换一批
              <RefreshCw />
            </button>
          }
        />
        {feed.isLoading ? (
          <CardGridSkeleton />
        ) : feedCards.length > 0 ? (
          <div className="cards">
            {feedCards.slice(0, 6).map((card, index) => (
              <CoverCard
                key={`${card.type}-${card.id}-${index}`}
                title={card.title}
                subtitle={card.subtitle || (card.type === 'playlist' ? '歌单' : '歌曲')}
                cover={cardCover(card)}
                glyph={feedCardGlyph(card)}
                seed={card.playlistId ?? card.id}
                rank={index + 1}
                onOpen={() => openCard(card)}
                onPlay={() => playCard(card)}
              />
            ))}
          </div>
        ) : square.isLoading ? (
          <CardGridSkeleton />
        ) : square.data && square.data.length > 0 ? (
          <div className="cards">
            {square.data.slice(0, 6).map((playlist, index) => (
              <CoverCard
                key={playlist.id}
                title={playlist.title}
                subtitle={`${playlist.songCount} 首 · ${formatCount(playlist.playCount)} 播放`}
                cover={playlist.cover}
                seed={playlist.id}
                rank={index + 1}
                onOpen={() => openPlaylist(playlist)}
                onPlay={() => openPlaylist(playlist)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Heart />}
            title="暂时没有推荐内容"
            description="推荐流需要网络连接，稍后再试。"
            action={
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void feed.refetch()}>
                重新加载
              </button>
            }
          />
        )}
      </section>

      <section className="section">
        <SectionHeader
          title="为你推荐"
          subtitle="编辑精选歌单 · 匿名可读"
          action={
            <button type="button" className="more" onClick={() => void square.refetch()}>
              换一批
              <RefreshCw />
            </button>
          }
        />
        {square.isLoading ? (
          <CardGridSkeleton />
        ) : (
          <div className="cards">
            {(square.data ?? []).slice(heroSongs.length > 0 ? 0 : 1, 7).map((playlist) => (
              <CoverCard
                key={playlist.id}
                title={playlist.title}
                subtitle={`${playlist.songCount} 首 · ${formatCount(playlist.playCount)} 播放`}
                cover={playlist.cover}
                seed={playlist.id}
                onOpen={() => openPlaylist(playlist)}
                onPlay={() => openPlaylist(playlist)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <SectionHeader
          title="最近播放"
          subtitle="只记录在本机"
          action={
            recentSongs.length > 0 ? (
              <button type="button" className="more" onClick={() => navigate('/recent')}>
                全部
                <ArrowRight />
              </button>
            ) : undefined
          }
        />
        {recentSongs.length > 0 ? (
          <TrackTable
            songs={recentSongs}
            playingMid={playingMid}
            playing={playing}
            onPlay={(index) => void playQueue(recentSongs, index, '最近播放')}
            height={recentSongs.length > 5 ? 316 : undefined}
          />
        ) : recent.isLoading ? (
          <TracksSkeleton count={4} />
        ) : (
          <EmptyState
            icon={<Play />}
            title="还没有播放记录"
            description="播放一首歌之后，这里会留下最近 300 条记录。"
          />
        )}
      </section>
    </div>
  );
}
