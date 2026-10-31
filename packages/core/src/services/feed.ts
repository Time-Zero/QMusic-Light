import type { Account, FeedSection, Playlist, Song } from '@qmusic/shared-types';
import type { QqApi } from '../qq/client';
import { COMM } from '../qq/endpoints';
import { asArr, asObj, findDailyPlaylistId, mapFeed, mapSquare, toSongs } from '../qq/mappers';
import { TTL, endOfDay, type CacheStore } from '../cache/policy';
import type { PlaylistService } from './playlist';

export class FeedService {
  constructor(
    private readonly api: QqApi,
    private readonly cache: CacheStore,
    private readonly playlists: PlaylistService,
  ) {}

  /** 首页推荐流：未登录返回大众内容（文档 §2） */
  async sections(account?: Account, force = false): Promise<FeedSection[]> {
    const key = `feed:${account?.uin ?? 'guest'}`;
    if (!force) {
      const cached = this.cache.get<FeedSection[]>(key);
      if (cached) return cached;
    }
    const data = await this.api.feed(1, account ? COMM.app : COMM.web);
    const sections = mapFeed(data);
    this.cache.set(key, sections, TTL.feed);
    return sections;
  }

  /** 推荐歌单广场（编辑精选），匿名可读 */
  async square(size = 18): Promise<Playlist[]> {
    const key = `square:${size}`;
    const cached = this.cache.get<Playlist[]>(key);
    if (cached) return cached;
    const data = await this.api.square(0, size);
    const list = mapSquare(data);
    this.cache.set(key, list, TTL.square);
    return list;
  }

  /** 每日 30 首：推荐流下发歌单 id，再取详情，按天缓存（文档 §3.7-5） */
  async daily(account: Account): Promise<{ playlistId: number; day: string; songs: import('@qmusic/shared-types').Song[] }> {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
    const key = `daily:${account.uin}:${day}`;
    const cached = this.cache.get<{ playlistId: number; day: string; songs: import('@qmusic/shared-types').Song[] }>(key);
    if (cached) return cached;

    const feed = await this.api.feed(1, COMM.app);
    const playlistId = findDailyPlaylistId(feed);
    if (!playlistId) throw new Error('推荐流未下发「每日30首」');

    const detail = await this.playlists.detail(playlistId, { kind: 'daily', account, num: 30 });
    const result = { playlistId, day, songs: detail.songs.slice(0, 30) };
    this.cache.set(key, result, Math.max(60_000, endOfDay() - Date.now()));
    return result;
  }

  /**
   * 猜你喜欢 / 个性电台。
   * 上游单次只给 5 首左右（num 会被忽略），按实际返回条数推进 from 翻页凑够 num 首。
   */
  async radio(num = 10): Promise<Song[]> {
    const songs: Song[] = [];
    const seen = new Set<string>();
    let from = 0;
    // 兜底上限：避免上游反复返回同一批时死循环
    for (let round = 0; round < 8 && songs.length < num; round += 1) {
      const data = await this.api.radio(num, from);
      const raw = asObj(data);
      const tracks = toSongs(raw.tracks ?? (asArr(raw.v_track).length > 0 ? raw.v_track : data));
      if (tracks.length === 0) break;
      for (const song of tracks) {
        if (seen.has(song.mid)) continue;
        seen.add(song.mid);
        songs.push(song);
      }
      from += tracks.length;
    }
    return songs.slice(0, num);
  }
}
