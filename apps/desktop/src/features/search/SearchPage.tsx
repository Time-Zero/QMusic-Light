import { useQuery } from '@tanstack/react-query';
import { TTL } from '@core';
import type { Playlist } from '@qmusic/shared-types';
import { LogIn, Music2, Search, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useCore } from '@/app/core-context';
import { useAccount } from '@/features/auth/session-store';
import { usePlayerStore } from '@/features/player/player-store';
import { useDebouncedValue } from '@/shared/hooks/useDebouncedValue';
import { cn } from '@/shared/lib/cn';
import { formatCount } from '@/shared/lib/format';
import { CoverCard } from '@/shared/ui/CoverCard';
import { EmptyState } from '@/shared/ui/EmptyState';
import { CardGridSkeleton, TracksSkeleton } from '@/shared/ui/Skeleton';
import { TrackTable } from '@/shared/ui/TrackTable';
import { useUiStore } from '@/shared/ui/ui-store';

type Tab = 'songs' | 'playlists' | 'singers';

export default function SearchPage() {
  const core = useCore();
  const navigate = useNavigate();
  const account = useAccount();
  const setCrumb = useUiStore((s) => s.setCrumb);
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';

  const [input, setInput] = useState(urlQuery);
  const [submitted, setSubmitted] = useState(urlQuery);
  const [tab, setTab] = useState<Tab>('songs');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const playQueue = usePlayerStore((s) => s.playQueue);
  const playingMid = usePlayerStore((s) => (s.index >= 0 ? s.queue[s.index]?.mid : undefined));
  const playing = usePlayerStore((s) => s.playing);

  useEffect(() => {
    setCrumb('搜索');
    document.title = '搜索 · QQ 音乐 Lite';
  }, [setCrumb]);

  useEffect(() => {
    if (urlQuery !== submitted) {
      setInput(urlQuery);
      setSubmitted(urlQuery);
    }
  }, [urlQuery, submitted]);

  const debounced = useDebouncedValue(input, 250);

  const suggestions = useQuery({
    queryKey: ['suggest', debounced],
    queryFn: () => core.search.suggest(debounced),
    enabled: debounced.trim().length > 0 && focused,
    staleTime: 60_000,
    retry: 0,
  });

  const results = useQuery({
    queryKey: ['search', submitted],
    queryFn: () => core.search.all(submitted, 1, 30),
    enabled: submitted.trim().length > 0,
    staleTime: TTL.search,
    retry: 0,
  });

  const submit = (value: string) => {
    const keyword = value.trim();
    if (!keyword) return;
    setInput(keyword);
    setSubmitted(keyword);
    setParams({ q: keyword }, { replace: true });
    setFocused(false);
    inputRef.current?.blur();
  };

  const songs = results.data?.songs.items ?? [];
  const playlists = results.data?.playlists.items ?? [];
  const singers = results.data?.singers.items ?? [];

  const suggestOpen =
    focused &&
    debounced.trim().length > 0 &&
    Boolean(
      suggestions.data &&
        (suggestions.data.songs.length > 0 ||
          suggestions.data.singers.length > 0 ||
          suggestions.data.playlists.length > 0),
    );

  const tabCount = useMemo(
    () => ({ songs: songs.length, playlists: playlists.length, singers: singers.length }),
    [songs.length, playlists.length, singers.length],
  );

  const openPlaylist = (playlist: Playlist) => navigate(`/playlist/${playlist.id}?kind=public`);
  const noResults = submitted.trim().length > 0 && !results.isLoading && songs.length === 0 && playlists.length === 0 && singers.length === 0;

  return (
    <div className="search-page">
      <div className="search-hero">
        <div className="search-box">
          <Search />
          <input
            ref={inputRef}
            value={input}
            placeholder="搜索歌曲、歌单、歌手（Ctrl+F）"
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 150)}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit(input);
            }}
          />
          {input ? (
            <button type="button" className="clear" title="清空" onClick={() => setInput('')}>
              <X size={16} />
            </button>
          ) : null}
        </div>

        {suggestOpen && suggestions.data ? (
          <div className="suggest-panel">
            {suggestions.data.songs.length > 0 ? (
              <>
                <div className="suggest-group">单曲</div>
                {suggestions.data.songs.slice(0, 4).map((song) => (
                  <button
                    key={`s-${song.mid}`}
                    type="button"
                    className="suggest-item"
                    onClick={() => submit(`${song.name} ${song.singer}`.trim())}
                  >
                    <Music2 />
                    <span className="ellipsis">{song.name}</span>
                    <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
                      {song.singer}
                    </span>
                  </button>
                ))}
              </>
            ) : null}
            {suggestions.data.singers.length > 0 ? (
              <>
                <div className="suggest-group">歌手</div>
                {suggestions.data.singers.slice(0, 3).map((singer) => (
                  <button
                    key={`g-${singer.mid}`}
                    type="button"
                    className="suggest-item"
                    onClick={() => submit(singer.name)}
                  >
                    <Sparkles />
                    <span>{singer.name}</span>
                  </button>
                ))}
              </>
            ) : null}
            {suggestions.data.playlists.length > 0 ? (
              <>
                <div className="suggest-group">歌单</div>
                {suggestions.data.playlists.slice(0, 3).map((playlist) => (
                  <button
                    key={`p-${playlist.id}`}
                    type="button"
                    className="suggest-item"
                    onClick={() => navigate(`/playlist/${playlist.id}?kind=public`)}
                  >
                    <Music2 />
                    <span className="ellipsis">{playlist.name}</span>
                  </button>
                ))}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {!submitted ? (
        <EmptyState
          icon={<Search />}
          title="搜索你喜欢的音乐"
          description="支持歌曲、歌单、歌手；输入时会有联想词。QQ 音乐搜索接口在未登录时会返回空结果。"
        />
      ) : (
        <>
          <div className="search-toolbar">
            <div className="tabs" role="tablist">
              <button
                type="button"
                className={cn('tab', tab === 'songs' && 'active')}
                onClick={() => setTab('songs')}
              >
                单曲 {tabCount.songs > 0 ? `· ${tabCount.songs}` : ''}
              </button>
              <button
                type="button"
                className={cn('tab', tab === 'playlists' && 'active')}
                onClick={() => setTab('playlists')}
              >
                歌单 {tabCount.playlists > 0 ? `· ${tabCount.playlists}` : ''}
              </button>
              <button
                type="button"
                className={cn('tab', tab === 'singers' && 'active')}
                onClick={() => setTab('singers')}
              >
                歌手 {tabCount.singers > 0 ? `· ${tabCount.singers}` : ''}
              </button>
            </div>
            <span className="result-count">
              {results.isFetching ? '搜索中…' : `关键词「${submitted}」`}
            </span>
          </div>

          {results.isError ? (
            <div className="error-banner">
              <TriangleAlert />
              搜索失败：{results.error instanceof Error ? results.error.message : '未知错误'}
            </div>
          ) : null}

          {noResults ? (
            <EmptyState
              icon={!account ? <LogIn /> : <Search />}
              title={!account ? '暂无搜索结果' : '没有找到结果'}
              description={
                !account
                  ? 'QQ 音乐搜索接口对匿名或高频请求会返回空结果（风控）。可以稍后重试，或扫码登录后再搜索。'
                  : '换一个关键词试试，或检查网络连接。'
              }
              action={
                !account ? (
                  <button type="button" className="btn btn-primary" onClick={() => navigate('/login')}>
                    <LogIn />
                    扫码登录
                  </button>
                ) : undefined
              }
            />
          ) : tab === 'songs' ? (
            results.isLoading ? (
              <TracksSkeleton />
            ) : (
              <TrackTable
                songs={songs}
                playingMid={playingMid}
                playing={playing}
                onPlay={(index) => void playQueue(songs, index, `搜索：${submitted}`)}
              />
            )
          ) : tab === 'playlists' ? (
            results.isLoading ? (
              <CardGridSkeleton />
            ) : playlists.length > 0 ? (
              <div className="cards">
                {playlists.map((playlist) => (
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
            ) : (
              <EmptyState icon={<Search />} title="没有匹配的歌单" />
            )
          ) : results.isLoading ? (
            <CardGridSkeleton />
          ) : singers.length > 0 ? (
            <div className="cards">
              {singers.map((singer) => (
                <CoverCard
                  key={singer.mid || singer.name}
                  title={singer.name}
                  subtitle="歌手"
                  cover={singer.pic}
                  seed={singer.mid || singer.name}
                  glyph="♪"
                  onOpen={() => submit(singer.name)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={<Search />} title="没有匹配的歌手" />
          )}
        </>
      )}
    </div>
  );
}
