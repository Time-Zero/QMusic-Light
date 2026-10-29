import type { Account, Quality } from '@qmusic/shared-types';
import { QqApi, type ApiTransport } from './qq/client';
import type { CacheStore } from './cache/policy';
import type { DbClient } from './storage/db';
import { LibraryRepo } from './storage/library-repo';
import { SongService } from './services/song';
import { PlaylistService } from './services/playlist';
import { FeedService } from './services/feed';
import { SearchService } from './services/search';
import { StreamService } from './services/stream';
import { AccountService } from './services/account';
import { QqProvider } from './provider';

export * from './qq/hash33';
export * from './qq/endpoints';
export * from './qq/client';
export * from './qq/mappers';
export * from './cache/policy';
export * from './cache/persistent';
export * from './storage/db';
export * from './storage/library-repo';
export * from './services/song';
export * from './services/playlist';
export * from './services/feed';
export * from './services/search';
export * from './services/stream';
export * from './services/account';
export * from './player/queue';
export * from './provider';

export interface CoreDeps {
  transport: ApiTransport;
  cache: CacheStore;
  db: DbClient;
  getAccount: () => Account | undefined;
  getGuid: () => string;
  getQuality: () => Quality;
}

/** 领域层组装：所有服务共享同一个 transport / cache / db */
export function createCore(deps: CoreDeps) {
  const api = new QqApi(deps.transport);
  const songs = new SongService(api, deps.cache);
  const playlists = new PlaylistService(api, deps.cache);
  const feed = new FeedService(api, deps.cache, playlists);
  const search = new SearchService(api, deps.transport);
  const stream = new StreamService(api, deps.cache, () => ({
    guid: deps.getGuid(),
    uin: deps.getAccount()?.uin ?? '0',
    quality: deps.getQuality(),
  }));
  const account = new AccountService(deps.transport);
  const repo = new LibraryRepo(deps.db);

  const provider = new QqProvider({
    api,
    songs,
    playlists,
    feed,
    search,
    stream,
    account,
    getAccount: deps.getAccount,
  });

  return { api, songs, playlists, feed, search, stream, account, repo, provider, cache: deps.cache };
}

export type Core = ReturnType<typeof createCore>;
