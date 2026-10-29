import type {
  FeedSection,
  Lyric,
  Page,
  Playlist,
  Quality,
  Song,
  StreamInfo,
} from '@qmusic/shared-types';
import type { QqApi } from './qq/client';
import type { AccountService } from './services/account';
import type { FeedService } from './services/feed';
import type { PlaylistService } from './services/playlist';
import type { SearchService } from './services/search';
import type { SongService } from './services/song';
import type { StreamService } from './services/stream';

export type Capability =
  | 'search'
  | 'playlist'
  | 'favorite'
  | 'daily'
  | 'recommend'
  | 'lyric'
  | 'stream';

export type PlaylistId = number;

/** 多音源抽象（文档 §5.3）：新增网易云只需实现该接口并注册 */
export interface MusicProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<Capability>;
  search(q: string, page: number): Promise<Page<Song>>;
  playlist(id: PlaylistId): Promise<Playlist>;
  playlistTracks(id: PlaylistId, offset: number, limit: number): Promise<Page<Song>>;
  daily(): Promise<Playlist & { tracks: Song[] }>;
  recommend(): Promise<FeedSection[]>;
  lyric(song: Song): Promise<Lyric>;
  stream(song: Song, quality: Quality): Promise<StreamInfo>;
}

export interface QqProviderDeps {
  api: QqApi;
  songs: SongService;
  playlists: PlaylistService;
  feed: FeedService;
  search: SearchService;
  stream: StreamService;
  account: AccountService;
  getAccount: () => import('@qmusic/shared-types').Account | undefined;
}

export class QqProvider implements MusicProvider {
  readonly id = 'qq';
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'search',
    'playlist',
    'favorite',
    'daily',
    'recommend',
    'lyric',
    'stream',
  ]);

  constructor(private readonly deps: QqProviderDeps) {}

  async search(q: string, page: number): Promise<Page<Song>> {
    return this.deps.search.songs(q, page);
  }

  async playlist(id: PlaylistId): Promise<Playlist> {
    const detail = await this.deps.playlists.detail(id, { account: this.deps.getAccount() });
    return detail.playlist;
  }

  async playlistTracks(id: PlaylistId, offset: number, limit: number): Promise<Page<Song>> {
    const detail = await this.deps.playlists.detail(id, {
      begin: offset,
      num: limit,
      account: this.deps.getAccount(),
    });
    return {
      items: detail.songs,
      total: detail.total,
      hasMore: offset + detail.songs.length < detail.total,
    };
  }

  async daily(): Promise<Playlist & { tracks: Song[] }> {
    const account = this.deps.getAccount();
    if (!account) throw new Error('每日 30 首需要登录');
    const daily = await this.deps.feed.daily(account);
    const detail = await this.deps.playlists.detail(daily.playlistId, {
      kind: 'daily',
      account,
      num: 30,
    });
    return { ...detail.playlist, kind: 'daily', tracks: daily.songs };
  }

  async recommend(): Promise<FeedSection[]> {
    return this.deps.feed.sections(this.deps.getAccount());
  }

  async lyric(song: Song): Promise<Lyric> {
    return this.deps.songs.lyric(song);
  }

  async stream(song: Song, quality: Quality): Promise<StreamInfo> {
    return this.deps.stream.resolve(song, quality);
  }
}
